import { useCallback, useEffect, useRef, useState } from 'react';

// TouchPasteButton — paste into a live interactive pane from a phone
// (E-12(b)). The desktop path is a native `paste` event on `document`
// (PaneBox): Cmd/Ctrl+V or Edit ▸ Paste. A phone has neither, and the
// TouchTermInput textarea it types through is 1px and invisible, so there is
// nothing to long-press for the system Paste bubble. This button is that
// affordance; its owner sends the text to the PTY the same way the soft
// keyboard does.
//
// navigator.clipboard.readText exists only in a secure context (HTTPS or
// localhost). A phone reaching the daemon on `--bind 0.0.0.0` over plain http
// — the common LAN case — has no navigator.clipboard at all, and a secure page
// can still be refused (permission, no user gesture). Either way the button
// opens a sheet with a real, visible textarea: the user long-presses ▸ Paste
// into it (the OS paste needs no clipboard API) and taps Send. The sheet says
// why it appeared, so a missing clipboard API is legible, not a dead button.
//
// Copy and paste are deliberately separate controls: copy reads a pane buffer
// out to this device (PaneCopyButton); paste types keystrokes into a PTY and
// only means something on an interactive pane.

interface Props {
  /** Send the pasted text to the pane (UTF-8 encoding is the owner's job). */
  onPaste: (text: string) => void;
}

const INSECURE_NOTE =
  'This is not a secure (HTTPS) page, so it cannot read the clipboard. ' +
  'Long-press below, choose Paste, then Send.';
const REFUSED_NOTE =
  'This browser would not let the page read the clipboard. ' +
  'Long-press below, choose Paste, then Send.';
const EMPTY_NOTE = 'The clipboard looked empty. Paste or type below, then Send.';

export function TouchPasteButton({ onPaste }: Props) {
  const [sheet, setSheet] = useState<string | null>(null);
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Called synchronously from the tap: readText needs the user gesture.
  const onTap = useCallback(async () => {
    const readText = window.isSecureContext ? navigator.clipboard?.readText : undefined;
    if (!readText) {
      setSheet(INSECURE_NOTE);
      return;
    }
    let clip: string;
    try {
      clip = await readText.call(navigator.clipboard);
    } catch {
      setSheet(REFUSED_NOTE);
      return;
    }
    if (!clip) {
      setSheet(EMPTY_NOTE);
      return;
    }
    onPaste(clip);
  }, [onPaste]);

  useEffect(() => {
    if (sheet) taRef.current?.focus();
  }, [sheet]);

  const close = () => {
    setSheet(null);
    setText('');
  };

  return (
    <>
      <button
        type="button"
        // Keep focus on the hidden TouchTermInput so the keyboard stays up
        // on the direct-read path (same trick as TouchKeyMenu).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void onTap()}
        aria-label="Paste into pane"
        title="Paste into this pane"
        className="px-1.5 rounded border border-[#555] bg-[#333] text-[#d4d4d4] text-[13px] active:bg-[#444]"
      >
        📥
      </button>

      {sheet && (
        <div className="fixed inset-x-0 bottom-0 z-[300] flex justify-center p-3">
          <div className="w-[92%] max-w-[600px] rounded-lg border-2 border-[#5f87ff] px-4 py-3 shadow-lg bg-[#2a2a2a]">
            <div className="text-[13px] text-[#d4d4d4] break-words">{sheet}</div>
            <textarea
              ref={taRef}
              aria-label="Text to paste"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              // ≥16px: iOS zooms the page when a smaller field gains focus.
              style={{ fontSize: '16px' }}
              className="mt-2 w-full h-[20vh] bg-[#1a1a1a] border border-[#555] rounded p-2 text-[#d4d4d4] font-mono outline-none"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="min-h-[44px] px-3 rounded border border-[#555] bg-[#333] text-[#d4d4d4] text-[13px]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!text) return;
                  onPaste(text);
                  close();
                }}
                className="min-h-[44px] px-3 rounded border border-[#00af87] bg-[#333] text-[#87ffd7] text-[13px]"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
