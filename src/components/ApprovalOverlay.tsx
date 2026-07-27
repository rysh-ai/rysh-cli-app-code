import { useEffect } from 'react';
import { useStore } from '../store';
import { renderDiffHtml } from '../utils/diff';
import { sendCommand } from '../utils/commands';

export function ApprovalOverlay() {
  const pendingApproval = useStore((s) => s.pendingApproval);
  const mode = useStore((s) => s.mode);
  const active = !!pendingApproval && (mode === 'approval' || mode === 'reject_reason');

  // A native WebContentsView (embedded browser) renders above ALL HTML, so this
  // DOM dialog would be occluded by a web pane's browser. While the dialog is up,
  // hide the web views; restore them when it closes.
  useEffect(() => {
    if (!active) return;
    window.electronAPI?.webPane?.setSuppressed?.(true);
    return () => {
      window.electronAPI?.webPane?.setSuppressed?.(false);
    };
  }, [active]);

  if (!active || !pendingApproval) return null;

  const req = pendingApproval.request;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60">
      <div className="bg-[#2a2a2a] border-2 border-[#00d7d7] rounded-lg px-6 py-4 max-w-[600px] w-[90%] shadow-lg">
        <h3 className="text-[#ffffaf] text-sm font-bold mb-2">APPROVAL REQUIRED</h3>
        <div className="text-[#d4d4d4] text-[13px] mb-1.5 whitespace-pre-wrap break-words">
          {req.description || 'A tool action requires your approval.'}
        </div>

        {req.diff?.unified_diff && (
          <div
            className="bg-[#1a1a1a] border border-[#444] rounded px-2 py-2 my-2 max-h-[300px] overflow-auto text-[12px] whitespace-pre-wrap font-mono"
            dangerouslySetInnerHTML={{ __html: renderDiffHtml(req.diff.unified_diff) }}
          />
        )}

        {req.choices && req.choices.length > 0 && (
          <div className="my-2">
            <div className="text-[#808080] text-[11px] mb-1">Choices:</div>
            {req.choices.map((choice, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-[13px] text-[#d4d4d4] py-1 px-2 rounded hover:bg-[#333] cursor-pointer"
                onClick={() => {
                  const store = useStore.getState();
                  if (store.pendingApproval) {
                    sendCommand('approval_response', {
                      pane_id: store.pendingApproval.pane_id,
                      request_id: store.pendingApproval.request.request_id,
                      decision: 'choice_selected',
                      reason: String(i),
                    });
                    store.setPendingApproval(null);
                    store.setMode('normal');
                  }
                }}
              >
                <kbd className="bg-[#444] text-[#d4d4d4] px-1.5 rounded font-mono text-[11px] shrink-0">
                  {i + 1}
                </kbd>
                <span className="font-bold">{choice.label}</span>
                {choice.description && (
                  <span className="text-[#808080] text-[12px] ml-1">— {choice.description}</span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 text-[#808080] text-[12px]">
          <kbd className="bg-[#444] text-[#d4d4d4] px-1 rounded font-mono">y</kbd> approve{' '}
          &nbsp;
          <kbd className="bg-[#444] text-[#d4d4d4] px-1 rounded font-mono">Y</kbd> approve
          always &nbsp;
          <kbd className="bg-[#444] text-[#d4d4d4] px-1 rounded font-mono">n</kbd> reject
          &nbsp;
          <kbd className="bg-[#444] text-[#d4d4d4] px-1 rounded font-mono">N</kbd> reject with
          reason &nbsp;
          <kbd className="bg-[#444] text-[#d4d4d4] px-1 rounded font-mono">Esc</kbd> reject
        </div>

        {mode === 'reject_reason' && (
          <div className="mt-2">
            <input
              type="text"
              id="rejection-reason"
              placeholder="reason for rejection..."
              className="w-full bg-[#1a1a1a] border border-[#00d7d7] rounded px-2.5 py-1.5 text-[#d4d4d4] font-mono text-[13px] outline-none"
              autoFocus
            />
          </div>
        )}
      </div>
    </div>
  );
}
