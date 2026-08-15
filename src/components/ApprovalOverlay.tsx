import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { renderDiffHtml } from '../utils/diff';
import { submitApproval } from '../utils/approvals';

// One dialog, two input methods. The desktop answers with y/Y/n/N/Esc
// (useKeyboard), and every one of those answers is also a button here — because
// this same overlay is what the phone shows (MobileApp), and a phone has no y
// key. Both paths call submitApproval, so neither can drift from the wire
// format or forget to close the dialog.
const BTN =
  'min-h-[44px] px-4 rounded font-mono text-[13px] border active:opacity-80 select-none';

export function ApprovalOverlay() {
  const pendingApproval = useStore((s) => s.pendingApproval);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const approvalError = useStore((s) => s.approvalError);
  const setApprovalError = useStore((s) => s.setApprovalError);
  const active = !!pendingApproval && (mode === 'approval' || mode === 'reject_reason');
  const [reason, setReason] = useState('');

  // A native WebContentsView (embedded browser) renders above ALL HTML, so this
  // DOM dialog would be occluded by a web pane's browser. While the dialog is up,
  // hide the web views; restore them when it closes.
  useEffect(() => {
    if (!active) {
      // Never carry one request's reason into the next one.
      setReason('');
      return;
    }
    window.electronAPI?.webPane?.setSuppressed?.(true);
    return () => {
      window.electronAPI?.webPane?.setSuppressed?.(false);
    };
  }, [active]);

  // A refused answer (approval_error) outlives the dialog it belonged to, so it
  // gets its own banner rather than a line inside a dialog that is already gone.
  if (!active || !pendingApproval) {
    return approvalError ? (
      <div className="fixed inset-x-0 bottom-0 z-[300] flex justify-center p-3 pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-3 max-w-[600px] w-[90%] bg-[#2a2a2a] border-2 border-[#ff8787] rounded-lg px-4 py-3 shadow-lg">
          <div className="flex-1 text-[#ff8787] text-[13px] break-words">
            <span className="font-bold">Approval not delivered.</span> {approvalError}
          </div>
          <button
            type="button"
            onClick={() => setApprovalError(null)}
            className={`${BTN} bg-[#333] border-[#555] text-[#d4d4d4] shrink-0`}
          >
            Dismiss
          </button>
        </div>
      </div>
    ) : null;
  }

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
                onClick={() => submitApproval('choice_selected', String(i))}
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

        {mode === 'approval' && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => submitApproval('yes')}
              className={`${BTN} bg-[#00875f] border-[#00af87] text-white font-bold`}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => submitApproval('yes_always')}
              className={`${BTN} bg-[#005f5f] border-[#00875f] text-[#d4d4d4]`}
            >
              Always
            </button>
            <button
              type="button"
              onClick={() => submitApproval('no')}
              className={`${BTN} bg-[#870000] border-[#af5f5f] text-white font-bold`}
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => setMode('reject_reason')}
              className={`${BTN} bg-[#333] border-[#555] text-[#d4d4d4]`}
            >
              Reason…
            </button>
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
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              id="rejection-reason"
              placeholder="reason for rejection..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="flex-1 min-w-0 bg-[#1a1a1a] border border-[#00d7d7] rounded px-2.5 py-1.5 text-[#d4d4d4] font-mono text-[13px] outline-none"
              autoFocus
            />
            {/* Enter also submits (useKeyboard), but a phone's return key is
                not guaranteed to, so the send has its own tap target. */}
            <button
              type="button"
              onClick={() => submitApproval('no_with_explanation', reason.trim())}
              className={`${BTN} bg-[#870000] border-[#af5f5f] text-white font-bold shrink-0`}
            >
              Send
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
