import { useState } from 'react';
import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import type { TabSnapshot } from '../types';

/** Validate a grid spec: 1-3 positive dimensions (rysh-cli de2ed21 / 785140d):
 *  N (stack N in active lane), LxP (lanes x panes in active tab),
 *  TxLxP (tabs x lanes x panes). "x" or whitespace separated. */
export function isValidGridSpec(spec: string): boolean {
  const parts = spec.trim().split(/[x\s]+/i).filter(Boolean);
  return parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p) && parseInt(p) >= 1);
}

/** Validate a single positive integer (for ##new stack N). */
export function isValidCount(s: string): boolean {
  return /^\d+$/.test(s.trim()) && parseInt(s.trim()) >= 1;
}

/** Count total attention across all panes in a tab (across all lane/group/panes). */
export function tabAttentionCount(tab: TabSnapshot): number {
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

/** The tab's display label: its title plus the pipeline suffix the TUI shows. */
export function tabLabel(tab: TabSnapshot, index: number): string {
  let label = tab.title || `tab-${index + 1}`;
  if (tab.pipeline_active && tab.pipeline_name) {
    label += ` [${tab.pipeline_name}]`;
  } else if (tab.pipeline_enabled) {
    label += ' [pipe]';
  }
  return label;
}

export type TabBarOrientation = 'horizontal' | 'vertical';

/** Whether the tab bar is currently the left-hand column rather than the header
 *  strip. The daemon owns this (rysh-cli 408a9a8): it is per-workspace state
 *  that rides the snapshot and is persisted with the layout, so there is no
 *  local copy to keep in step.
 *
 *  One definition, because three places read it with two polarities — the
 *  header drops its strip, the toolbar labels its button, App renders the
 *  column — and they have to agree or the session shows two tab bars or none.
 *  A daemon too old to send the field reports horizontal, the default. */
export function useTabBarVertical(): boolean {
  return useStore((s) => !!s.snapshot?.tab_bar_vertical);
}

/** Flip the tab bar between the horizontal strip and the left-hand column.
 *  Mirrors `##tab orientation toggle` / the TUI's ctrl+t v — the daemon owns
 *  the orientation (it is per-workspace and persisted), so this sends the same
 *  typed message and waits for the snapshot rather than flipping locally. */
export function toggleTabOrientation(): void {
  sendCommand('set_tab_orientation', { orientation: 'toggle' });
}

/**
 * TabBar renders the workspace's tabs, either as the strip under the workspace
 * row (horizontal) or as a column down the left edge of the body (vertical) —
 * the two orientations of rysh-cli's `##tab orientation` (408a9a8).
 *
 * Both orientations render the same list from the same snapshot, so a tab's
 * label, attention marker and click target cannot differ between them; only the
 * flex direction, the active-tab marker and the popover placement change.
 *
 * Unlike the TUI's column there is no "+N more" row: the terminal has to bound
 * the column or the footer falls off the screen, but this one is a scroll
 * container, so overflow just scrolls and every tab stays reachable.
 */
export function TabBar({ orientation }: { orientation: TabBarOrientation }) {
  const tabs = useStore((s) => s.snapshot?.tabs);
  const activeTabId = useStore((s) => s.snapshot?.active_tab_id);
  const [gridOpen, setGridOpen] = useState(false);
  const [newKind, setNewKind] = useState<'grid' | 'stack'>('grid');
  const [gridSpec, setGridSpec] = useState('3x4');

  const vertical = orientation === 'vertical';
  const newValid = newKind === 'grid' ? isValidGridSpec(gridSpec) : isValidCount(gridSpec);

  function submitNew() {
    const spec = gridSpec.trim();
    if (!newValid) return;
    // ##new grid / ##new stack are text system commands handled by the daemon
    // (rysh-cli de2ed21 / 785140d); route via submit_input to the active pane.
    const cmd = newKind === 'grid' ? `##new grid ${spec}` : `##new stack ${spec}`;
    // pane_id anchors the new grid/stack to the pane the user sees focused —
    // this window's own focus, not the daemon's (see resolveFocus in store.ts).
    // armFocusFollow because the user asked for these panes: the daemon focuses
    // the one it just made, and that move is the answer to this click.
    sendCommand('submit_input', {
      text: cmd,
      mode: 'rysh',
      pane_id: useStore.getState().getEffectiveActivePaneID(),
    });
    useStore.getState().armFocusFollow();
    setGridOpen(false);
  }

  function setNewMode(kind: 'grid' | 'stack') {
    setNewKind(kind);
    setGridSpec(kind === 'grid' ? '3x4' : '4');
  }

  return (
    <div
      data-testid="tab-bar"
      data-orientation={orientation}
      className={
        vertical
          ? 'w-[180px] shrink-0 h-full flex flex-col gap-0.5 py-1 overflow-y-auto overflow-x-hidden bg-[#1a1a1a] border-r border-[#333]'
          : 'flex items-center gap-1 flex-1 overflow-x-auto'
      }
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {tabs?.map((tab, i) => {
        const isActive = tab.id === activeTabId;
        const label = tabLabel(tab, i);
        const attnCount = tabAttentionCount(tab);
        return (
          <div
            key={tab.id}
            onClick={() => sendCommand('focus_tab_index', { index: i })}
            title={vertical ? label : undefined}
            className={`cursor-pointer select-none transition-colors duration-100 text-[12px] flex items-center gap-1 ${
              vertical
                // The column's active row carries a left bar in place of the
                // rounded pill, mirroring the TUI's ▌ marker. Rows are full
                // width so the column reads as one rectangle.
                ? `shrink-0 mx-1 px-2 py-1 rounded-sm border-l-2 ${
                    isActive ? 'border-[#ffffaf]' : 'border-transparent'
                  }`
                : 'px-2.5 py-0.5 rounded whitespace-nowrap'
            } ${
              isActive
                ? 'bg-[#5f5f87] text-[#ffffaf] font-bold'
                : attnCount > 0
                  ? 'text-[#ff5f5f] font-bold animate-pulse'
                  : 'text-[#8a8a8a] hover:text-[#bbb] hover:bg-[#2a2a2a]'
            }`}
          >
            {/* The column shows the 1-based tab number the way the TUI's
                vertical bar does — it is also what ctrl+t <n> jumps to. */}
            {vertical && (
              <span className={`text-[10px] shrink-0 ${isActive ? 'text-[#ffff87]' : 'text-[#585858]'}`}>
                {i + 1}
              </span>
            )}
            <span className={vertical ? 'truncate' : undefined}>{label}</span>
            {attnCount > 0 && (
              <span
                className={`text-[10px] ${vertical ? 'ml-auto shrink-0' : ''} ${
                  isActive ? 'text-[#ffff87]' : 'text-[#ff5f5f]'
                }`}
              >
                {'●'}{attnCount}
              </span>
            )}
          </div>
        );
      })}

      {/* New tab (##new tab / ##rysh new tab / ctrl+t n) */}
      <div
        onClick={() => sendCommand('create_tab')}
        title="New tab (##new tab)"
        className={`rounded cursor-pointer select-none shrink-0 leading-none text-[#808080] hover:text-[#bbb] hover:bg-[#2a2a2a] ${
          vertical ? 'mx-1 px-2 py-1 text-[12px]' : 'px-2 py-0.5 text-[14px]'
        }`}
      >
        {vertical ? '+ new tab' : '+'}
      </div>

      {/* New grid / stack (##new grid N|LxP|TxLxP, ##new stack N) */}
      <div className={`relative shrink-0 ${vertical ? 'mx-1' : ''}`}>
        <div
          onClick={() => setGridOpen((v) => !v)}
          title="New grid / stack (##new grid, ##new stack)"
          className={`rounded cursor-pointer select-none text-[12px] leading-none ${
            vertical ? 'px-2 py-1' : 'px-2 py-0.5'
          } ${gridOpen ? 'bg-[#2a2a2a] text-[#bbb]' : 'text-[#808080] hover:text-[#bbb] hover:bg-[#2a2a2a]'}`}
        >
          {vertical ? '▦ grid…' : '▦'}
        </div>
        {gridOpen && (
          // In the column the popover opens to the RIGHT of the bar (left-full);
          // dropping it below would spill past a 180px-wide container.
          <div
            className={`absolute z-50 bg-[#1e1e1e] border border-[#555] rounded p-2 shadow-lg flex flex-col gap-1.5 w-56 ${
              vertical ? 'top-0 left-full ml-1' : 'top-7 left-0'
            }`}
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
  );
}
