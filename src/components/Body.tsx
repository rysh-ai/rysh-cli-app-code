import { useStore, type PaneContentBuf, type PaneVTBuf } from '../store';
import { sendCommand } from '../utils/commands';
import { PaneBox } from './PaneBox';
import type { TabSnapshot, PaneSnapshot, LaneSnapshot, ConversationMessage, InputMode } from '../types';

// rehydratePane merges streamed per-pane content/VT (content plane, ?stream=1)
// back onto a pane so the existing render path reads pane.output / vt_screen as
// before. A no-op when no streamed buffer exists (e.g. a full-snapshot client,
// where the snapshot already carries content).
export function rehydratePane(pane: PaneSnapshot, content?: PaneContentBuf, vt?: PaneVTBuf): PaneSnapshot {
  if (!content && !vt) return pane;
  const next: PaneSnapshot = { ...pane };
  if (content) {
    next.output = content.output;
    next.ai_output = content.aiOutput;
    next.rysh_output = content.ryshOutput;
    next.chat_output = content.chatOutput;
    next.external_output = content.externalOutput;
    // Dynamic per-humanoid mode buffers (e.g. "slack-bot") live in the content
    // cache once seeded/streamed; surface them so resolveOutput renders the
    // live buffer rather than the stale snapshot's mode_outputs.
    if (content.modeOutputs) next.mode_outputs = content.modeOutputs;
  }
  if (vt) {
    // raw_mode / remote_interactive ride the pane_vt content-plane delta — for a
    // stream client (?stream=1) that delta is the ONLY real-time interactivity
    // signal, because raw-mode transitions don't emit a layout snapshot. Apply
    // them here so the display flips to (and back from) the VT screen the instant
    // the delta lands. Without this, pane.raw_mode stays on the stale layout
    // snapshot and an interactive app (e.g. claude) renders blank until an
    // unrelated event (clicking the pane → focus → layoutDirty) refreshes it.
    if (typeof vt.raw_mode === 'boolean') next.raw_mode = vt.raw_mode;
    if (typeof vt.remote_interactive === 'boolean') next.remote_interactive = vt.remote_interactive;
    if (vt.vt_screen && vt.vt_screen.length) {
      next.vt_screen = vt.vt_screen;
      next.vt_cursor_row = vt.vt_cursor_row;
      next.vt_cursor_col = vt.vt_cursor_col;
    }
    if (vt.remote_vt_screen && vt.remote_vt_screen.length) {
      next.remote_vt_screen = vt.remote_vt_screen;
      next.remote_vt_cursor_row = vt.remote_vt_cursor_row;
      next.remote_vt_cursor_col = vt.remote_vt_cursor_col;
    }
  }
  return next;
}

export function findPaneInTab(tab: TabSnapshot, paneID: string): PaneSnapshot | null {
  for (const lane of tab.lanes || []) {
    for (const g of lane.pane_groups || []) {
      for (const p of g.panes || []) {
        if (p.id === paneID) return p;
      }
    }
  }
  return null;
}

/** Build conversation messages for a pane based on its input mode. */
export function buildConversationMessages(
  pane: PaneSnapshot,
  inputMode: string
): ConversationMessage[] | undefined {
  if (inputMode === 'chat' && pane.merged_conv && pane.merged_conv.length > 0) {
    return pane.merged_conv;
  }
  if (inputMode === 'external' && pane.merged_conv && pane.merged_conv.length > 0) {
    return pane.merged_conv.filter(
      (m) => ['email', 'slack', 'chatbot'].includes(m.conversation_type)
    );
  }
  return undefined;
}

/** Determine display output based on input mode. */
export function resolveOutput(
  pane: PaneSnapshot,
  inputMode: string,
  pipelineActive: boolean,
  pipelineOutput?: string
): string {
  if (pipelineActive && pipelineOutput) return pipelineOutput;
  // Prompt (AI) mode renders the AI-only stream, not the merged shell+AI
  // buffer, so ## system commands and shell output don't leak into the AI view
  // (rysh-cli 117bcce). The daemon echoes the user's prompt into ai_output too.
  if (inputMode === 'prompt') return pane.ai_output || '';
  if (inputMode === 'rysh') return pane.rysh_output || '';
  if (inputMode === 'chat') return pane.chat_output || '';
  if (inputMode === 'external') return pane.external_output || '';
  if (inputMode === 'web') return '';
  // Dynamic per-humanoid mode (e.g. "slack-bot"): render that humanoid's own
  // buffer rather than falling through to the merged shell output.
  if (pane.mode_outputs && inputMode in pane.mode_outputs) {
    return pane.mode_outputs[inputMode] || '';
  }
  return pane.output || '';
}

// lastExpandedByGroup remembers each stack group's expanded (active) pane so a
// degraded snapshot that omits the group's active id keeps the same card
// expanded instead of reshuffling the deck (see the sticky-card logic below).
// Module-level: survives re-renders, reset only on full reload; bounded by the
// number of groups ever seen in the session.
const lastExpandedByGroup = new Map<string, string>();

export function Body() {
  const snapshot = useStore((s) => s.snapshot);
  const fullscreenPaneID = useStore((s) => s.fullscreenPaneID);
  const setFullscreenPaneID = useStore((s) => s.setFullscreenPaneID);
  const effectiveActiveID = useStore((s) => s.getEffectiveActivePaneID());
  // Subscribe to the paneInputModes map itself (not the stable getInputMode fn) so
  // Body re-renders when double-Escape cycles a pane's input mode. cycleInputMode
  // replaces the map with a new object reference, so this selector fires a re-render
  // and the fresh mode flows down to PaneBox/PaneInput (prompt char + submit mode).
  const paneInputModes = useStore((s) => s.paneInputModes);
  const getInputMode = (id: string): InputMode => paneInputModes[id] || 'shell';
  const paneScrollLocked = useStore((s) => s.paneScrollLocked);
  const pipelineOutputs = useStore((s) => s.pipelineOutputs);
  const paneContent = useStore((s) => s.paneContent);
  const paneVT = useStore((s) => s.paneVT);
  const sidecarPort = useStore((s) => s.sidecarPort);

  if (!snapshot?.tabs) {
    // No sidecar port in Electron => no active session (e.g. after Detach).
    // Show a clear, intentional empty state that points the way back.
    if (window.electronAPI && !sidecarPort) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[#666] p-5 select-none">
          <div className="text-[15px] text-[#888]">No active session</div>
          <div className="text-[12px]">Open a workspace from File ▸ Open Workspace (⌘O)</div>
        </div>
      );
    }
    return <div className="flex-1 flex items-center justify-center text-[#555] p-5">no panes</div>;
  }

  const tab = snapshot.tabs.find((t) => t.id === snapshot.active_tab_id) || snapshot.tabs[0];
  if (!tab?.lanes || tab.lanes.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-[#555] p-5">no panes</div>;
  }

  // Merge snapshot pipeline output with real-time pipeline output from WebSocket events
  const effectivePipelineOutput = (tab.pipeline_output || '') + (pipelineOutputs[tab.id] || '');

  // Fullscreen mode
  if (fullscreenPaneID) {
    const found = findPaneInTab(tab, fullscreenPaneID);
    if (found) {
      const pane = rehydratePane(found, paneContent[found.id], paneVT[found.id]);
      const fsInputMode = getInputMode(pane.id);
      const fsConvMessages = buildConversationMessages(pane, fsInputMode);
      return (
        <div className="flex-1 overflow-hidden p-1 gap-1">
          <PaneBox
            key={pane.id}
            pane={pane}
            isActive={pane.id === effectiveActiveID}
            inputMode={fsInputMode}
            pipelineActive={!!tab.pipeline_active && pane.id === effectiveActiveID}
            isFullscreen
            scrollLocked={paneScrollLocked[pane.id]}
            conversationMessages={fsConvMessages}
          />
        </div>
      );
    }
    // Pane not found, exit fullscreen
    setFullscreenPaneID(null);
  }

  return (
    <div className="flex-1 flex overflow-hidden p-1 gap-1">
      {tab.lanes.map((lane: LaneSnapshot) => {
        // Lane name (rysh-cli f59e26c): falls back to the tab's pipeline name.
        // Rendered once, on the first visible (expanded) pane of the lane.
        const laneName = lane.name || tab.pipeline_name || '';
        let laneLabelPaneId = '';
        for (const g of lane.pane_groups || []) {
          const gp = g.panes || [];
          if (gp.length === 0) continue;
          // The visible (top) pane of a group is its active_pane_id, not
          // necessarily array index 0 (a freshly stacked pane is appended).
          laneLabelPaneId =
            (g.active_pane_id && gp.some((p) => p.id === g.active_pane_id))
              ? g.active_pane_id
              : gp[0].id;
          break;
        }
        return (
        <div
          key={lane.id}
          className="flex flex-col gap-1 min-w-[120px] overflow-hidden"
          style={{ flex: lane.flex || 1 }}
        >
          {(lane.pane_groups || []).map((group) => {
            const groupPanes = group.panes || [];
            if (groupPanes.length === 0) return null;

            // Stacked panes render Zellij-style, exactly like the TUI's
            // FlatLanes path: ALL panes stay in their stable creation order
            // (1,2,3,4,5 …) and the active pane (group.active_pane_id)
            // expands IN PLACE — collapsed title bars of earlier panes sit
            // above it, later panes below it. Activating a pane never
            // reorders the stack (previously the active card was pulled to
            // the top of the group, so 1,2,3,4,5 with 4 active displayed as
            // 4,1,2,3,5). [n/N] labels carry each pane's stable position.
            // The raw snapshot does NOT carry stack_collapsed / stack_total
            // (the daemon only fills those in its TUI FlatLanes path), so
            // derive them here.
            const stackTotal = groupPanes.length;
            // Sticky expanded card: when a (degraded) snapshot omits the
            // group's active pane, KEEP the last known expanded pane instead
            // of falling back to the first — a transient fallback unmounted
            // the focused pane's input and flashed another pane expanded
            // ("the pane jumps under load"). First pane only when this group
            // has never reported an active pane at all.
            let activeId =
              group.active_pane_id && groupPanes.some((p) => p.id === group.active_pane_id)
                ? group.active_pane_id
                : undefined;
            if (!activeId) {
              const remembered = lastExpandedByGroup.get(group.id);
              activeId =
                remembered && groupPanes.some((p) => p.id === remembered)
                  ? remembered
                  : groupPanes[0].id;
            }
            lastExpandedByGroup.set(group.id, activeId);
            const isStacked = stackTotal > 1;

            return (
              <div key={group.id} style={{ flex: group.row_flex || 1 }} className="flex flex-col min-h-0">
                {groupPanes.map((pane, stackPosition) => {
                  if (pane.id !== activeId) {
                    // Collapsed (background) stacked pane: single title bar
                    // line at its stable position in the stack.
                    return (
                      <PaneBox
                        key={pane.id}
                        pane={{ ...pane, stack_total: stackTotal, stack_position: stackPosition, stack_collapsed: true }}
                        isActive={pane.id === effectiveActiveID}
                        inputMode={getInputMode(pane.id)}
                        pipelineActive={false}
                        isCollapsed
                        scrollLocked={false}
                      />
                    );
                  }

                  // Expanded (visible) pane: full rendering, in place.
                  // Rehydrate streamed content/VT (content plane) first.
                  const rpane = rehydratePane(pane, paneContent[pane.id], paneVT[pane.id]);
                  const activeIsFocused = pane.id === effectiveActiveID;
                  const activeInputMode = getInputMode(pane.id);
                  const pipelineActive = !!tab.pipeline_active && activeIsFocused;
                  const conversationMessages = buildConversationMessages(rpane, activeInputMode);
                  const output = resolveOutput(rpane, activeInputMode, pipelineActive, effectivePipelineOutput);
                  let paneForBox = isStacked
                    ? { ...rpane, stack_total: stackTotal, stack_position: stackPosition, stack_collapsed: false }
                    : rpane;
                  if (output !== paneForBox.output) paneForBox = { ...paneForBox, output };

                  return (
                    <PaneBox
                      key={pane.id}
                      pane={paneForBox}
                      isActive={activeIsFocused}
                      inputMode={activeInputMode}
                      pipelineActive={pipelineActive}
                      scrollLocked={paneScrollLocked[pane.id]}
                      conversationMessages={conversationMessages}
                      laneName={pane.id === laneLabelPaneId ? laneName : undefined}
                    />
                  );
                })}
              </div>
            );
          })}
          {/* New pane at the bottom of this lane (##new pane / ctrl+p v).
              Focus the lane first so the split-down targets it; both commands
              go to the workspace inbox in order, so focus is applied first. */}
          <button
            onClick={() => {
              if (lane.active_pane_id) {
                sendCommand('focus_pane_by_id', { id: lane.active_pane_id });
              }
              sendCommand('create_pane_down');
            }}
            title="New pane below in this lane (##new pane)"
            className="shrink-0 py-0.5 rounded text-[11px] text-[#666] hover:text-[#9a9aaf] hover:bg-[#2a2a2a] border border-dashed border-[#3a3a3a] hover:border-[#5a5a7a] select-none"
          >
            + pane
          </button>
        </div>
        );
      })}
      {/* New lane / column in the active tab (##new lane / ctrl+p n). */}
      <div
        onClick={() => sendCommand('create_pane')}
        title="New lane (##new lane)"
        className="shrink-0 w-7 flex items-center justify-center rounded cursor-pointer text-[#666] hover:text-[#9a9aaf] hover:bg-[#222] border border-dashed border-[#3a3a3a] hover:border-[#5a5a7a] select-none text-[15px] leading-none"
      >
        +
      </div>
    </div>
  );
}
