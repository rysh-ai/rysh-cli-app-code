import { useEffect, useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useVisualViewport } from './hooks/useVisualViewport';
import { ModeTabBar } from './components/ModeTabBar';
import { FileBrowser } from './components/FileBrowser';
import { ApprovalOverlay } from './components/ApprovalOverlay';
import { PaneCopyButton } from './components/PaneCopyButton';
import { useStore } from './store';
import { sendCommand } from './utils/commands';
import { PaneBox } from './components/PaneBox';
import {
  rehydratePane,
  resolveOutput,
  buildConversationMessages,
  findPaneInTab,
} from './components/Body';
import type { TabSnapshot, PaneSnapshot, InputMode } from './types';

// MobileApp — the small-screen UI served at /mobile/.
//
// A phone can't usefully render the desktop's column/stack layout, so instead of
// squeezing every pane onto one screen this is a three-level drill-down:
//
//   Tabs  ─tap→  Panes (in that tab)  ─tap→  Pane (full-screen)
//
// It reuses the exact same data plane as the desktop web UI: useWebSocket() opens
// the one content-plane socket (full snapshot + per-pane deltas), and the pane
// screen renders the shared <PaneBox> via the same rehydrate/resolve helpers that
// Body.tsx uses. Selecting a tab/pane also focuses it on the daemon so input,
// snapshots and raw-mode key routing all line up.

type View = 'tabs' | 'panes' | 'pane';

function paneLabel(p: PaneSnapshot): string {
  return p.given_name || p.title || p.id.slice(0, 8);
}

function modeLabel(m: InputMode): string {
  switch (m) {
    case 'shell':
      return 'Shell';
    case 'prompt':
      return 'AI';
    case 'rysh':
      return 'Rysh';
    case 'chat':
      return 'Chat';
    case 'external':
      return 'External';
    case 'web':
      return 'Web';
    default:
      return m || 'Shell';
  }
}

function countPanes(tab: TabSnapshot): number {
  let n = 0;
  for (const lane of tab.lanes || [])
    for (const g of lane.pane_groups || []) n += (g.panes || []).length;
  return n;
}

function TopBar({
  title,
  subtitle,
  onBack,
  connected,
  actions,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  connected: boolean;
  actions?: React.ReactNode;
}) {
  return (
    <div className="shrink-0 flex items-center gap-2 h-12 px-3 bg-[#222] border-b border-[#333] select-none">
      {onBack ? (
        <button
          onClick={onBack}
          className="text-[#9a9aaf] hover:text-white active:text-white text-[26px] leading-none px-2 -ml-2"
          aria-label="Back"
        >
          {'‹'}
        </button>
      ) : (
        <span className="text-[#00d7d7] font-bold text-[15px] px-1">rysh</span>
      )}
      <span className="flex-1 min-w-0">
        <span className="block font-bold text-[14px] text-white truncate leading-tight">{title}</span>
        {subtitle && <span className="block text-[11px] text-[#808080] truncate leading-tight">{subtitle}</span>}
      </span>
      {actions}
      <span
        className={`w-2.5 h-2.5 rounded-full shrink-0 ${connected ? 'bg-[#00d75f]' : 'bg-[#ff5f5f]'}`}
        title={connected ? 'connected' : 'disconnected'}
      />
    </div>
  );
}

function Row({
  active,
  activeColor,
  title,
  subtitle,
  badge,
  onClick,
}: {
  active: boolean;
  activeColor: string;
  title: string;
  subtitle?: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-[#2a2a2a] text-left active:bg-[#2a2a2a]"
    >
      <span className={`w-1.5 h-9 rounded shrink-0 ${active ? activeColor : 'bg-transparent'}`} />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          {badge && <span className="text-[10px] text-[#808080] shrink-0 font-mono">{badge}</span>}
          <span className="text-[15px] text-white truncate">{title}</span>
        </span>
        {subtitle && <span className="block text-[12px] text-[#808080] truncate">{subtitle}</span>}
      </span>
      <span className="text-[#666] text-[20px] shrink-0">{'›'}</span>
    </button>
  );
}

export default function MobileApp() {
  return (
    <>
      <MobileScreens />
      {/* A gated tool blocks the agent until someone answers it, and the phone
          is often the surface that is actually to hand. The overlay sits
          OUTSIDE the drill-down so an approval is answerable from the tab list
          or the pane list — not only after navigating to the pane that raised
          it, which is a request nobody answers. Same component the desktop
          mounts (App.tsx), so both surfaces answer through one path. */}
      <ApprovalOverlay />
    </>
  );
}

function MobileScreens() {
  useWebSocket();

  const snapshot = useStore((s) => s.snapshot);
  const connected = useStore((s) => s.connected);
  const paneContent = useStore((s) => s.paneContent);
  const paneVT = useStore((s) => s.paneVT);
  const paneInputModes = useStore((s) => s.paneInputModes);
  const pipelineOutputs = useStore((s) => s.pipelineOutputs);
  const effectiveActiveID = useStore((s) => s.getEffectiveActivePaneID());
  const getInputMode = (id: string): InputMode => paneInputModes[id] || 'shell';

  const [view, setView] = useState<View>('tabs');
  const [selectedTabId, setSelectedTabId] = useState('');
  const [selectedPaneId, setSelectedPaneId] = useState('');
  // File browser overlay (pane screen 📁 button), keyed off the open pane.
  const [showFiles, setShowFiles] = useState(false);
  const setInputMode = useStore((s) => s.setInputMode);

  // Soft-keyboard avoidance (rysh-mobile's KeyboardAvoidingView, web analog):
  // size the pane screen to the VISUAL viewport, not 100vh. When the keyboard
  // opens, visualViewport.height shrinks → the pane view shrinks above the
  // keyboard → usePaneResize re-fits the PTY, so an interactive app (claude)
  // redraws with its input line visible instead of hidden under the keyboard.
  const { height: vvHeight } = useVisualViewport();
  const paneScreenStyle = { height: vvHeight > 0 ? `${vvHeight}px` : '100vh' };

  const tabs = snapshot?.tabs || [];
  const selectedTab = tabs.find((t) => t.id === selectedTabId) || null;

  // Keep navigation valid as snapshots arrive: if the selected tab/pane vanishes
  // (closed elsewhere, workspace switch), fall back to the nearest valid level
  // instead of rendering a dead screen.
  useEffect(() => {
    if (view === 'panes' && selectedTabId && !tabs.some((t) => t.id === selectedTabId)) {
      setView('tabs');
    } else if (view === 'pane') {
      const t = tabs.find((x) => x.id === selectedTabId);
      if (!t) setView('tabs');
      else if (!findPaneInTab(t, selectedPaneId)) setView('panes');
    }
  }, [snapshot, view, selectedTabId, selectedPaneId, tabs]);

  function openTab(t: TabSnapshot) {
    const idx = tabs.findIndex((x) => x.id === t.id);
    if (idx >= 0) sendCommand('focus_tab_index', { index: idx });
    setSelectedTabId(t.id);
    setView('panes');
  }

  function openPane(paneId: string) {
    // Line up the daemon's active tab first, then focus the pane — so submit_input,
    // snapshots and raw-mode keystrokes all target this pane.
    const idx = tabs.findIndex((x) => x.id === selectedTabId);
    if (idx >= 0) sendCommand('focus_tab_index', { index: idx });
    sendCommand('focus_pane_by_id', { id: paneId });
    // Tapping a pane names it outright, so claim focus here rather than waiting
    // on the daemon — and last, so it also closes the follow window that
    // focus_tab_index just armed (this tap is the newer, more specific intent).
    useStore.getState().focusPane(paneId);
    setSelectedPaneId(paneId);
    setShowFiles(false);
    setView('pane');
  }

  if (!snapshot) {
    return (
      <div className="flex flex-col h-screen w-screen bg-[#1e1e1e] text-[#d4d4d4]">
        <TopBar title="rysh" connected={connected} />
        <div className="flex-1 flex items-center justify-center text-[#666] text-[14px]">
          {connected ? 'Loading workspace…' : 'Connecting to rysh…'}
        </div>
      </div>
    );
  }

  // ── Pane screen ──────────────────────────────────────────────────────────
  if (view === 'pane' && selectedTab) {
    const found = findPaneInTab(selectedTab, selectedPaneId);
    return (
      <div
        className="flex flex-col w-screen bg-[#1e1e1e] text-[#d4d4d4] overflow-hidden"
        style={paneScreenStyle}
      >
        <TopBar
          title={found ? paneLabel(found) : 'pane'}
          subtitle={selectedTab.title}
          onBack={() => {
            setShowFiles(false);
            setView('panes');
          }}
          connected={connected}
          actions={
            found ? (
              <>
                {/* Out of the pane, onto this device — the direction a phone
                    cannot get any other way (no mouse selection, no scrollback). */}
                <PaneCopyButton pane={found} inputMode={getInputMode(found.id)} />
                <button
                  type="button"
                  onClick={() => setShowFiles(true)}
                  className="text-[18px] px-1.5 py-0.5 rounded bg-[#333] border border-[#555] active:bg-[#444]"
                  aria-label="Browse files"
                >
                  📁
                </button>
              </>
            ) : undefined
          }
        />
        {found && (
          <ModeTabBar
            active={getInputMode(found.id)}
            onChange={(m) => setInputMode(found.id, m)}
            enabledModes={found.enabled_modes}
          />
        )}
        {found && showFiles && (
          <FileBrowser paneId={found.id} onClose={() => setShowFiles(false)} />
        )}
        <div className="flex-1 min-h-0 flex flex-col p-1">
          {found ? (
            (() => {
              const rp = rehydratePane(found, paneContent[found.id], paneVT[found.id]);
              const inputMode = getInputMode(rp.id);
              const pipelineActive = !!selectedTab.pipeline_active && rp.id === effectiveActiveID;
              const pipelineOut =
                (selectedTab.pipeline_output || '') + (pipelineOutputs[selectedTab.id] || '');
              const output = resolveOutput(rp, inputMode, pipelineActive, pipelineOut);
              const conv = buildConversationMessages(rp, inputMode);
              const paneForBox = output !== rp.output ? { ...rp, output } : rp;
              return (
                <PaneBox
                  pane={paneForBox}
                  isActive
                  inputMode={inputMode}
                  pipelineActive={pipelineActive}
                  conversationMessages={conv}
                />
              );
            })()
          ) : (
            <div className="flex-1 flex items-center justify-center text-[#666]">pane not found</div>
          )}
        </div>
      </div>
    );
  }

  // ── Panes list ───────────────────────────────────────────────────────────
  if (view === 'panes' && selectedTab) {
    return (
      <div className="flex flex-col h-screen w-screen bg-[#1e1e1e] text-[#d4d4d4] overflow-hidden">
        <TopBar
          title={selectedTab.title || 'tab'}
          subtitle={`${countPanes(selectedTab)} panes`}
          onBack={() => setView('tabs')}
          connected={connected}
        />
        <div className="flex-1 overflow-y-auto">
          {(selectedTab.lanes || []).map((lane, li) => (
            <div key={lane.id}>
              <div className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide text-[#6a6a8a] select-none">
                {lane.name || `column ${li + 1}`}
              </div>
              {(lane.pane_groups || []).map((g) =>
                (g.panes || []).map((p, pos) => {
                  const total = (g.panes || []).length;
                  return (
                    <Row
                      key={p.id}
                      active={p.id === effectiveActiveID}
                      activeColor="bg-[#00d75f]"
                      title={paneLabel(p)}
                      subtitle={`${modeLabel(getInputMode(p.id))} · ${p.status || 'idle'}`}
                      badge={total > 1 ? `[${pos + 1}/${total}]` : undefined}
                      onClick={() => openPane(p.id)}
                    />
                  );
                })
              )}
            </div>
          ))}
          <button
            onClick={() => {
              const idx = tabs.findIndex((x) => x.id === selectedTabId);
              if (idx >= 0) sendCommand('focus_tab_index', { index: idx });
              sendCommand('create_pane');
            }}
            className="w-full px-4 py-3 text-left text-[13px] text-[#666] active:bg-[#2a2a2a] border-b border-dashed border-[#333]"
          >
            + new pane
          </button>
        </div>
      </div>
    );
  }

  // ── Tabs list (default) ──────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen w-screen bg-[#1e1e1e] text-[#d4d4d4] overflow-hidden">
      <TopBar title="Tabs" connected={connected} />
      <div className="flex-1 overflow-y-auto">
        {tabs.map((t) => {
          const n = countPanes(t);
          return (
            <Row
              key={t.id}
              active={t.id === snapshot.active_tab_id}
              activeColor="bg-[#00d7d7]"
              title={t.title || 'tab'}
              subtitle={`${n} pane${n === 1 ? '' : 's'}`}
              onClick={() => openTab(t)}
            />
          );
        })}
        <button
          onClick={() => sendCommand('create_tab')}
          className="w-full px-4 py-3 text-left text-[13px] text-[#666] active:bg-[#2a2a2a] border-b border-dashed border-[#333]"
        >
          + new tab
        </button>
      </div>
    </div>
  );
}
