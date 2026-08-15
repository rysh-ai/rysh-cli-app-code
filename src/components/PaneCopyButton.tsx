import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { PaneSnapshot } from '../types';
import {
  clipboardSourceFor,
  describeSize,
  requestPaneCopy,
  writeClipboard,
} from '../utils/clipboard';

// The copy affordance for a touch surface (E16 T3 client half).
//
// A phone has no mouse selection and no terminal to scroll back through, so
// "give me this pane's output" is the only form of the question it can ask —
// which is exactly what clipboard_copy answers. The button owns the whole
// exchange (request id, reply, clipboard write, outcome) so that no other
// surface can half-drive it.
//
// The outcome is always shown. navigator.clipboard is absent over plain http —
// how a phone usually reaches a rysh daemon on a LAN — and rejects in Safari
// outside a user gesture, which our write is: the text arrives one round trip
// after the tap. A clipboard write that quietly failed is indistinguishable
// from one that worked until the user pastes something stale into a bug report.

type Outcome =
  | { kind: 'copied'; note: string }
  | { kind: 'manual'; note: string; text: string }
  | { kind: 'error'; note: string };

export function PaneCopyButton({
  pane,
  inputMode,
  isActive = true,
}: {
  pane: PaneSnapshot;
  inputMode: string;
  isActive?: boolean;
}) {
  const clipboardResult = useStore((s) => s.clipboardResult);
  const setClipboardResult = useStore((s) => s.setClipboardResult);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const source = clipboardSourceFor(pane, inputMode, isActive);

  useEffect(() => {
    if (!pendingId || !clipboardResult || clipboardResult.requestId !== pendingId) return;
    const reply = clipboardResult;
    setPendingId(null);
    setClipboardResult(null);

    if (reply.err) {
      setOutcome({ kind: 'error', note: reply.err });
      return;
    }
    const tail = reply.truncated ? ', the tail of a longer buffer' : '';
    void writeClipboard(reply.text).then((ok) => {
      setOutcome(
        ok
          ? { kind: 'copied', note: `Copied ${describeSize(reply.text)} of ${reply.source}${tail}.` }
          : {
              kind: 'manual',
              note: `This browser would not let the page write the clipboard — select and copy the ${reply.source} below${tail}.`,
              text: reply.text,
            }
      );
    });
  }, [clipboardResult, pendingId, setClipboardResult]);

  // Preselect the fallback text so "select and copy" is one long-press, not a
  // drag across a phone-sized textarea.
  useEffect(() => {
    if (outcome?.kind === 'manual') textRef.current?.select();
  }, [outcome]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOutcome(null);
          setPendingId(requestPaneCopy(pane.id, source));
        }}
        className="text-[18px] px-1.5 py-0.5 rounded bg-[#333] border border-[#555] active:bg-[#444]"
        aria-label="Copy pane output"
        // Says what it does and does not claim a round trip: pasting into a
        // pane is a different path (keystrokes to a PTY, interactive panes
        // only) and this button is not its other half.
        title={`Copy this pane's ${source} to this device`}
      >
        {pendingId ? '⏳' : '📋'}
      </button>

      {outcome && (
        <div className="fixed inset-x-0 bottom-0 z-[300] flex justify-center p-3">
          <div
            className={`w-[92%] max-w-[600px] rounded-lg border-2 px-4 py-3 shadow-lg bg-[#2a2a2a] ${
              outcome.kind === 'copied' ? 'border-[#00af87]' : 'border-[#ff8787]'
            }`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`flex-1 text-[13px] break-words ${
                  outcome.kind === 'copied' ? 'text-[#87ffd7]' : 'text-[#ff8787]'
                }`}
              >
                {outcome.note}
              </div>
              <button
                type="button"
                onClick={() => setOutcome(null)}
                className="min-h-[44px] px-3 rounded border border-[#555] bg-[#333] text-[#d4d4d4] text-[13px] shrink-0"
              >
                Close
              </button>
            </div>

            {outcome.kind === 'manual' && (
              <textarea
                ref={textRef}
                readOnly
                aria-label="Pane output to copy"
                value={outcome.text}
                className="mt-2 w-full h-[30vh] bg-[#1a1a1a] border border-[#555] rounded p-2 text-[#d4d4d4] font-mono text-[12px] outline-none"
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
