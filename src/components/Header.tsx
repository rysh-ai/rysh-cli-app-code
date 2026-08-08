import { useState } from 'react';
import { useStore } from '../store';
import { sendCommand, sendControlStatus } from '../utils/commands';
import type { TabSnapshot } from '../types';

/** Validate a grid spec: 1-3 positive dimensions (rysh-cli de2ed21 / 785140d):
 *  N (stack N in active lane), LxP (lanes x panes in active tab),
 *  TxLxP (tabs x lanes x panes). "x" or whitespace separated. */
function isValidGridSpec(spec: string): boolean {
  const parts = spec.trim().split(/[x\s]+/i).filter(Boolean);
  return parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p) && parseInt(p) >= 1);
}

/** Validate a single positive integer (for ##new stack N). */
function isValidCount(s: string): boolean {
  return /^\d+$/.test(s.trim()) && parseInt(s.trim()) >= 1;
}

/** Count total attention across all panes in a tab (across all lane/group/panes). */
function tabAttentionCount(tab: TabSnapshot): number {
  let total = 0;
  for (const lane of tab.lanes || []) {
    for (const g of lane.pane_groups || []) {
      for (const p of g.panes || []) {
        if (p.attention_count && p.attention_count > 0) {
          total += p.attention_count;
        }
      }
    }
  }
  return total;
}

export function Header() {
  const tabs = useStore((s) => s.snapshot?.tabs);
  const activeTabId = useStore((s) => s.snapshot?.active_tab_id);
  const showAgentPanel = useStore((s) => s.showAgentPanel);
  const showHumanoidPanel = useStore((s) => s.showHumanoidPanel);
  const showSharePanel = useStore((s) => s.showSharePanel);
  const showDashboard = useStore((s) => s.showDashboard);
  const workspaceName = useStore((s) => s.workspaceName);
  const webEnv = useStore((s) => s.webEnv);
  const workspaces = useStore((s) => s.snapshot?.workspaces);
  const activeWorkspace = useStore((s) => s.snapshot?.active_workspace ?? 0);
  const [gridOpen, setGridOpen] = useState(false);
  const [newKind, setNewKind] = useState<'grid' | 'stack'>('grid');
  const [gridSpec, setGridSpec] = useState('3x4');
  const [bcOpen, setBcOpen] = useState(false);
  const [bcScope, setBcScope] = useState('tab');
  const [bcCmd, setBcCmd] = useState('');
  const [reloading, setReloading] = useState(false);

  // Reload only the app UI (renderer); the daemon and all its state (NATS,
  // panes, running shells) keep running on the same port. Electron-only.
  function reloadApp() {
    window.electronAPI?.reloadApp?.();
  }

  // Restart the Go daemon against the binary on disk (swaps in a freshly built
  // sidecar) and reload the renderer. Electron-only — a no-op in the browser
  // build where there is no spawned daemon to restart.
  async function restartDaemon() {
    if (reloading || !window.electronAPI?.restartDaemon) return;
    setReloading(true);
    try {
      await window.electronAPI.restartDaemon();
      // On success the main process reloads this window, so the line below only
      // runs if the restart failed (the window stayed alive).
    } catch {
      /* ignore — the window is being torn down */
    }
    setReloading(false);
  }

  // Detach: leave the daemon running (full in-memory state preserved) and quit
  // the app. Reattach later by reopening the same workspace + session in the
  // picker. Electron-only. The app quits, so no post-call UI update is needed.
  function detachSession() {
    window.electronAPI?.detachSession?.();
  }

  const newValid = newKind === 'grid' ? isValidGridSpec(gridSpec) : isValidCount(gridSpec);

  function submitNew() {
    const spec = gridSpec.trim();
    if (!newValid) return;
    // ##new grid / ##new stack are text system commands handled by the daemon
    // (rysh-cli de2ed21 / 785140d); route via submit_input to the active pane.
    const cmd = newKind === 'grid' ? `##new grid ${spec}` : `##new stack ${spec}`;
    sendCommand('submit_input', { text: cmd, mode: 'rysh' });
    setGridOpen(false);
  }

  function setNewMode(kind: 'grid' | 'stack') {
    setNewKind(kind);
    setGridSpec(kind === 'grid' ? '3x4' : '4');
  }

  function submitBroadcast() {
    const cmd = bcCmd.trim();
    if (!cmd) return;
    // ##cmd broadcasts a bash command across the chosen scope (rysh-cli
    // 7b29e63). It's a text system command, routed via submit_input. Shared
    // and pipeline-tab panes are excluded by the daemon.
    sendCommand('submit_input', { text: `##cmd ${bcScope} ${cmd}`, mode: 'shell' });
    setBcCmd('');
    setBcOpen(false);
  }

  const hasMultipleWorkspaces = !!workspaces && workspaces.length > 1;
  const wsSingleName = (workspaces && workspaces[0]) || workspaceName || 'default';
  // On macOS the traffic-light buttons overlay the top-left of the window
  // (titleBarStyle: hiddenInset), so pad the first row to clear them.
  const isMacElectron =
    typeof navigator !== 'undefined' &&
    /Macintosh/.test(navigator.userAgent) &&
    !!window.electronAPI;

  return (
    <div className="shrink-0 bg-[#1a1a1a] border-b border-[#333]">
      {/* Row 1: workspace switcher (draggable title bar; traffic lights live
          here on macOS). Mirrors the rysh-cli TUI's top "ws:" row (722560e). */}
      <div
        className="h-[30px] flex items-center gap-1 select-none overflow-hidden"
        style={{
          WebkitAppRegion: 'drag',
          paddingLeft: isMacElectron ? 78 : 12,
          paddingRight: 12,
        } as React.CSSProperties}
      >
        <span className="text-[11px] text-[#8a8aaf] font-medium shrink-0">ws:</span>
        {hasMultipleWorkspaces ? (
          <div
            className="flex items-center gap-1 overflow-x-auto"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {workspaces!.map((ws, i) => {
              const active = i === activeWorkspace;
              return (
                <div
                  key={i}
                  onClick={() => sendCommand('switch_workspace', { index: i })}
                  title={`Switch to workspace ${ws}`}
                  className={`px-2 py-0.5 rounded cursor-pointer select-none whitespace-nowrap text-[11px] ${
                    active
                      ? 'bg-[#005f5f] text-[#87ffff] font-bold'
                      : 'text-[#8a8a8a] hover:text-[#bbb] hover:bg-[#2a2a2a]'
                  }`}
                >
                  {ws}
                </div>
              );
            })}
          </div>
        ) : (
          <span className="text-[11px] font-medium text-[#d4d4d4] shrink-0 whitespace-nowrap">
            {wsSingleName}
          </span>
        )}
        {/* Web-mode badge (roadmap W9): running in a browser against the rysh
            web server. The genuinely-native desktop controls (reload app,
            restart daemon, detach) don't exist here — this note is the visible
            affordance replacing them, so nothing degrades silently. */}
        {!window.electronAPI && webEnv?.isWeb && (
          <span
            title={`Connected to rysh session "${webEnv.sessionName}" on ${webEnv.platform} via the browser. Desktop-only controls (reload app, restart daemon, detach session, native folder picker) are available in the Rysh desktop app.`}
            className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-[#1f3a3a] text-[#6fd7d7] shrink-0 cursor-help select-none"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            web
          </span>
        )}
        {/* Draggable filler so the rest of the row moves the window. */}
        <div className="flex-1 self-stretch" />
      </div>

      {/* Row 2: tabs + toolbar buttons */}
      <div className="px-3 pb-1 flex items-center gap-2">
        <div
          className="flex items-center gap-1 flex-1 overflow-x-auto"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {tabs?.map((tab, i) => {
            const isActive = tab.id === activeTabId;
            let label = tab.title || `tab-${i + 1}`;
            if (tab.pipeline_active && tab.pipeline_name) {
              label += ` [${tab.pipeline_name}]`;
            } else if (tab.pipeline_enabled) {
              label += ' [pipe]';
            }
            const attnCount = tabAttentionCount(tab);
            return (
              <div
                key={tab.id}
                onClick={() => sendCommand('focus_tab_index', { index: i })}
                className={`px-2.5 py-0.5 rounded cursor-pointer select-none whitespace-nowrap transition-colors duration-100 text-[12px] flex items-center gap-1 ${
                  isActive
                    ? 'bg-[#5f5f87] text-[#ffffaf] font-bold'
                    : attnCount > 0
                      ? 'text-[#ff5f5f] font-bold animate-pulse'
                      : 'text-[#8a8a8a] hover:text-[#bbb] hover:bg-[#2a2a2a]'
                }`}
              >
                {label}
                {attnCount > 0 && (
                  <span className={`text-[10px] ${isActive ? 'text-[#ffff87]' : 'text-[#ff5f5f]'}`}>
                    {'\u25cf'}{attnCount}
                  </span>
                )}
              </div>
            );
          })}
          {/* New tab (##new tab / ##rysh new tab / ctrl+t n) */}
          <div
            onClick={() => sendCommand('create_tab')}
            title="New tab (##new tab)"
            className="px-2 py-0.5 rounded cursor-pointer select-none shrink-0 text-[14px] leading-none text-[#808080] hover:text-[#bbb] hover:bg-[#2a2a2a]"
          >
            +
          </div>
          {/* New grid / stack (##new grid N|LxP|TxLxP, ##new stack N) */}
          <div className="relative shrink-0">
            <div
              onClick={() => setGridOpen((v) => !v)}
              title="New grid / stack (##new grid, ##new stack)"
              className={`px-2 py-0.5 rounded cursor-pointer select-none text-[12px] leading-none ${
                gridOpen ? 'bg-[#2a2a2a] text-[#bbb]' : 'text-[#808080] hover:text-[#bbb] hover:bg-[#2a2a2a]'
              }`}
            >
              {'▦'}
            </div>
            {gridOpen && (
              <div
                className="absolute top-7 left-0 z-50 bg-[#1e1e1e] border border-[#555] rounded p-2 shadow-lg flex flex-col gap-1.5 w-56"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <div className="flex items-center gap-0.5">
                  {(['grid', 'stack'] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setNewMode(k)}
                      className={`flex-1 px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer select-none uppercase ${
                        newKind === k
                          ? 'bg-[#5f5f87] text-[#ffffaf]'
                          : 'bg-[#2a2a2a] text-[#808080] hover:text-[#bbb] hover:bg-[#3a3a3a]'
                      }`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={gridSpec}
                  autoFocus
                  placeholder={newKind === 'grid' ? '2x3x4 / 3x4 / 4' : '4'}
                  onChange={(e) => setGridSpec(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); submitNew(); }
                    if (e.key === 'Escape') { e.preventDefault(); setGridOpen(false); }
                  }}
                  className="bg-[#1a1a1a] border border-[#00d7d7] rounded px-2 py-0.5 text-[#d4d4d4] font-mono text-[12px] outline-none"
                />
                <span className="text-[10px] text-[#585858]">
                  {newKind === 'grid'
                    ? 'N stacks in lane · LxP grid in tab · TxLxP across tabs'
                    : 'add N stacked panes to the active group'}
                </span>
                <button
                  onClick={submitNew}
                  disabled={!newValid}
                  className="px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer bg-[#005f5f] text-[#87ffff] hover:bg-[#008787] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Create
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Toolbar buttons */}
        <div
          className="flex items-center gap-1 shrink-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* Broadcast a bash command across a scope (##cmd, rysh-cli 7b29e63) */}
          <div className="relative shrink-0">
            <span
              onClick={() => setBcOpen((v) => !v)}
              title="Broadcast a command across panes (##cmd)"
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer select-none ${
                bcOpen ? 'bg-[#5f5f00] text-[#ffff87]' : 'bg-[#333] text-[#808080] hover:bg-[#444] hover:text-[#bbb]'
              }`}
            >
              {'⇶'}
            </span>
            {bcOpen && (
              <div className="absolute top-7 right-0 z-50 bg-[#1e1e1e] border border-[#555] rounded p-2 shadow-lg flex flex-col gap-1.5 w-64">
                <span className="text-[10px] text-[#808080] uppercase tracking-wide">Broadcast command (##cmd)</span>
                <div className="flex items-center gap-0.5">
                  {(['pane', 'stack', 'lane', 'tab', 'ws'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setBcScope(s)}
                      className={`flex-1 px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer select-none ${
                        bcScope === s
                          ? 'bg-[#5f5f87] text-[#ffffaf]'
                          : 'bg-[#2a2a2a] text-[#808080] hover:text-[#bbb] hover:bg-[#3a3a3a]'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={bcCmd}
                  autoFocus
                  placeholder="bash command, e.g. git status"
                  onChange={(e) => setBcCmd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); submitBroadcast(); }
                    if (e.key === 'Escape') { e.preventDefault(); setBcOpen(false); }
                  }}
                  className="bg-[#1a1a1a] border border-[#00d7d7] rounded px-2 py-0.5 text-[#d4d4d4] font-mono text-[12px] outline-none"
                />
                <span className="text-[10px] text-[#585858]">
                  runs in every pane of the active {bcScope}; shared &amp; pipeline panes are skipped
                </span>
                <button
                  onClick={submitBroadcast}
                  disabled={!bcCmd.trim()}
                  className="px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer bg-[#5f5f00] text-[#ffff87] hover:bg-[#878700] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Broadcast
                </button>
              </div>
            )}
          </div>
          {/* Reload app (renderer only; daemon kept running). Electron only. */}
          {!!window.electronAPI?.reloadApp && (
            <span
              onClick={reloadApp}
              title="Reload app — restart the UI only; the daemon keeps running"
              className="px-1.5 py-0.5 rounded text-[11px] font-bold cursor-pointer select-none leading-none bg-[#333] text-[#808080] hover:bg-[#444] hover:text-[#bbb]"
            >
              {'⟳'}
            </span>
          )}
          {/* Restart daemon (swaps in a freshly built sidecar). Electron only. */}
          {!!window.electronAPI?.restartDaemon && (
            <span
              onClick={restartDaemon}
              title="Restart daemon — reload the freshly built daemon binary (restarts the backend)"
              className={`px-1.5 py-0.5 rounded text-[11px] font-bold cursor-pointer select-none leading-none ${
                reloading
                  ? 'bg-[#5f0000] text-[#ff8787] animate-pulse cursor-default'
                  : 'bg-[#333] text-[#808080] hover:bg-[#444] hover:text-[#bbb]'
              }`}
            >
              {'⏻'}
            </span>
          )}
          {/* Detach session (leave daemon running, quit app). Electron only. */}
          {!!window.electronAPI?.detachSession && (
            <span
              onClick={detachSession}
              title="Detach session — quit the app but keep the daemon running; reattach later with full state"
              className="px-1.5 py-0.5 rounded text-[11px] font-bold cursor-pointer select-none leading-none bg-[#333] text-[#808080] hover:bg-[#444] hover:text-[#bbb]"
            >
              {'⏏'}
            </span>
          )}
          <span
            onClick={() => {
              useStore.getState().toggleAgentPanel();
              sendCommand('agent_list');
            }}
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer select-none ${
              showAgentPanel
                ? 'bg-[#005f5f] text-[#87ffff]'
                : 'bg-[#333] text-[#808080] hover:bg-[#444] hover:text-[#bbb]'
            }`}
          >
            AG
          </span>
          <span
            onClick={() => {
              useStore.getState().toggleHumanoidPanel();
              sendCommand('humanoid_list');
            }}
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer select-none ${
              showHumanoidPanel
                ? 'bg-[#005f5f] text-[#87ffff]'
                : 'bg-[#333] text-[#808080] hover:bg-[#444] hover:text-[#bbb]'
            }`}
          >
            HU
          </span>
          <span
            onClick={() => {
              useStore.getState().toggleSharePanel();
              sendCommand('share_list');
            }}
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer select-none ${
              showSharePanel
                ? 'bg-[#005f5f] text-[#87ffff]'
                : 'bg-[#333] text-[#808080] hover:bg-[#444] hover:text-[#bbb]'
            }`}
          >
            SH
          </span>
          {/* Control dashboard (design 005 / R1): channels, pairings, humanoids.
              Opens read-only; mutating controls appear only when the daemon
              reports control mode (##rysh web start --control). */}
          <span
            onClick={() => {
              useStore.getState().toggleDashboard();
              sendControlStatus();
              sendCommand('humanoid_list');
            }}
            title="Control dashboard — channels, pairings, humanoids"
            className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer select-none ${
              showDashboard
                ? 'bg-[#005f5f] text-[#87ffff]'
                : 'bg-[#333] text-[#808080] hover:bg-[#444] hover:text-[#bbb]'
            }`}
          >
            CTL
          </span>
        </div>
      </div>
    </div>
  );
}
