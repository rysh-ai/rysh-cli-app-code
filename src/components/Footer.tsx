import { useStore } from '../store';

export function Footer() {
  const mode = useStore((s) => s.mode);
  const snapshot = useStore((s) => s.snapshot);
  const connected = useStore((s) => s.connected);
  const fullscreenPaneID = useStore((s) => s.fullscreenPaneID);
  const pendingApproval = useStore((s) => s.pendingApproval);
  const getInputMode = useStore((s) => s.getInputMode);
  const renameText = useStore((s) => s.renameText);
  const setRenameText = useStore((s) => s.setRenameText);
  const voiceState = useStore((s) => s.voiceState);
  const voiceError = useStore((s) => s.voiceError);

  // The pane THIS window focuses, not the daemon's — the status bar has to name
  // the mode of the pane the keystrokes actually reach (see resolveFocus).
  const activePaneID = useStore((s) => s.getEffectiveActivePaneID());
  const inputMode = getInputMode(activePaneID);

  // Find active tab for pipeline state
  const activeTab = snapshot?.tabs?.find((t) => t.id === snapshot.active_tab_id);

  let modeText = '';
  let helpText = '';

  switch (mode) {
    case 'raw':
      modeText = 'RAW';
      helpText = 'raw (interactive) | ctrl+o prefix (escape hatch)';
      break;
    case 'prefix':
      modeText = 'PREFIX';
      helpText = 'ctrl+o prefix | d detach  any-key cancel';
      break;
    case 'altpprefix':
      modeText = 'ALT+P';
      helpText = 'f fullscreen-toggle | any-key cancel';
      break;
    case 'renamepane':
      modeText = 'RENAME';
      helpText = 'type new title | enter confirm | esc cancel';
      break;
    case 'renametab':
      modeText = 'RENAME TAB';
      helpText = 'type new tab name | enter confirm | esc cancel';
      break;
    case 'tab':
      modeText = 'TAB';
      helpText = 'h/l/[/] cycle | shift+←/→ move | 1-9 jump | n new tab | r rename | esc|. exit';
      break;
    case 'pane':
      modeText = 'PANE';
      helpText = 'n split-right | v split-down | s stack | x close | r rename | p pipeline | y rysh | c chat | d detach | esc|. exit';
      break;
    case 'navigate':
      modeText = 'NAVIGATE';
      helpText = 'h/j/k/l arrows traverse panes | esc|. exit | ctrl+space exit';
      break;
    case 'stack':
      modeText = 'STACK';
      helpText = 'j/k cycle stacked panes | esc|. exit';
      break;
    case 'movepane':
      modeText = 'MOVE';
      helpText = 'up/k move-up | down/j move-down | any-key exit';
      break;
    case 'layout':
      modeText = 'LAYOUT';
      helpText = 'h/= equalize-width | v equalize-height | arrows resize | m maximize | s swap-lane | esc|. exit';
      break;
    case 'resize':
      modeText = 'RESIZE';
      helpText = 'h/l width | j/k height | arrows resize | esc|. pane-mode | ctrl+p normal';
      break;
    case 'approval':
      modeText = 'APPROVAL';
      helpText = pendingApproval
        ? pendingApproval.request.description
        : 'y approve | Y always | n reject | N reject+reason | esc reject';
      break;
    case 'reject_reason':
      modeText = 'REJECTION';
      helpText = 'type reason then enter | esc cancel';
      break;
    default: {
      // Normal mode — show input mode cycle and shortcuts
      const modeHints: Record<string, string> = {
        shell: 'input:shell(>) esc\u00d72\u2192prompt ctrl+r search',
        prompt: 'input:prompt(<) esc\u00d72\u2192rysh',
        rysh: 'input:rysh(##) esc\u00d72\u2192chat',
        chat: 'input:chat(@) esc\u00d72\u2192external',
        external: 'input:external(\u21cb) esc\u00d72\u2192shell',
      };
      const parts = [modeHints[inputMode] || 'input:shell(>)'];
      parts.push('ctrl+space navigate');
      parts.push('[/] tabs');
      parts.push('ctrl+p panes');
      parts.push('ctrl+t tab-mode');
      parts.push('ctrl+l layout');
      parts.push('ctrl+s stack');
      parts.push('ctrl+y move-pane');
      parts.push('tab cycle');
      parts.push('alt+a agents');
      parts.push('alt+h humanoids');
      if (fullscreenPaneID) parts.push('alt+p f restore');
      if (activeTab?.pipeline_active) parts.push('pipeline active');
      helpText = parts.join(' | ');
      break;
    }
  }

  return (
    <div className="px-3 py-1 pb-1.5 shrink-0 border-t border-[#333] bg-[#1a1a1a] text-[#808080] text-[12px] flex items-center justify-between select-none">
      <span>
        {modeText && (
          <span className="bg-[#5f5f87] text-[#ffffaf] font-bold px-1.5 py-px rounded mr-2 text-[11px]">
            {modeText}
          </span>
        )}
        {helpText}
        {mode === 'renamepane' && (
          <input
            type="text"
            id="rename-input"
            value={renameText}
            placeholder="new pane title..."
            className="ml-2 bg-[#1a1a1a] border border-[#00d7d7] rounded px-2 py-px text-[#d4d4d4] font-mono text-[12px] outline-none w-48"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenameText(e.target.value)}
          />
        )}
        {mode === 'renametab' && (
          <input
            type="text"
            id="rename-tab-input"
            value={renameText}
            placeholder="new tab name..."
            className="ml-2 bg-[#1a1a1a] border border-[#00d7d7] rounded px-2 py-px text-[#d4d4d4] font-mono text-[12px] outline-none w-48"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenameText(e.target.value)}
          />
        )}
      </span>
      <span className="flex items-center gap-2 shrink-0">
        {voiceState === 'recording' && (
          <span className="text-[#ff5f5f] animate-pulse">{'●'} rec</span>
        )}
        {voiceState === 'transcribing' && (
          <span className="text-[#ffff87]">transcribing…</span>
        )}
        {voiceState === 'error' && voiceError && (
          <span className="text-[#ff8787] truncate max-w-[320px]" title={voiceError}>
            {voiceError.replace(/^voice:\s*/, 'voice: ')}
          </span>
        )}
        {!connected && <span>disconnected</span>}
      </span>
    </div>
  );
}
