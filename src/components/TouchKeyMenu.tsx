import React, { useCallback, useEffect, useRef, useState } from 'react';

// TouchKeyMenu — special-keys dropdown for live interactive panes on touch
// devices. A phone keyboard has no Esc, arrows, Tab, or Ctrl chords, so an
// interactive TUI (claude, vim, less) can't be fully driven from it. The ⌨
// button in the pane title bar opens a grid of those keys; tapping one sends
// its escape sequence to the PTY through the same path as typed keystrokes.
//
// Two focus details keep the phone keyboard OPEN while using the menu:
//   - onMouseDown preventDefault on every menu element, so tapping it never
//     steals focus from the hidden TouchTermInput textarea;
//   - after sending, onKey's owner re-focuses the textarea (still inside the
//     tap gesture, so iOS keeps the keyboard up).

interface KeyDef {
  label: string;
  seq: string;
  /** SS3 form sent instead of `seq` while DECCKM (application cursor keys)
   *  is active — termcap programs (less) ignore the CSI form. */
  appSeq?: string;
}

const KEYS: KeyDef[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: '↑', seq: '\x1b[A', appSeq: '\x1bOA' },
  { label: '↓', seq: '\x1b[B', appSeq: '\x1bOB' },
  { label: '←', seq: '\x1b[D', appSeq: '\x1bOD' },
  { label: '→', seq: '\x1b[C', appSeq: '\x1bOC' },
  { label: 'Tab', seq: '\t' },
  { label: '⇧Tab', seq: '\x1b[Z' },
  { label: 'Enter', seq: '\r' },
  { label: 'PgUp', seq: '\x1b[5~' },
  { label: 'PgDn', seq: '\x1b[6~' },
  { label: 'Home', seq: '\x1b[H', appSeq: '\x1bOH' },
  { label: 'End', seq: '\x1b[F', appSeq: '\x1bOF' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: '^Z', seq: '\x1a' },
  { label: '^R', seq: '\x12' },
];

interface Props {
  /** Send a key's raw sequence to the PTY (and re-focus the hidden input). */
  onKey: (seq: string) => void;
  /** Pane's DECCKM state (pane.app_cursor_keys from the snapshot). */
  appCursor?: boolean;
}

export function TouchKeyMenu({ onKey, appCursor }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  // Close when tapping anywhere outside the menu.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, [open]);

  const keepFocus = useCallback((e: React.MouseEvent) => e.preventDefault(), []);

  return (
    <span ref={rootRef} className="relative shrink-0" data-testid="touch-key-menu">
      <button
        type="button"
        onMouseDown={keepFocus}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`px-1.5 rounded text-[11px] leading-4 border ${
          open
            ? 'bg-[#00d7d7] text-[#1e1e1e] border-[#00d7d7]'
            : 'bg-[#333] text-[#d0d0d0] border-[#555]'
        }`}
        aria-label="special keys"
      >
        ⌨
      </button>
      {/* w-max: an absolutely-positioned grid otherwise shrink-wraps its
          minmax(0,1fr) columns to 0px, piling every key into one column that
          spills past the right screen edge on phones. */}
      {open && (
        <div
          onMouseDown={keepFocus}
          className="absolute right-0 top-full mt-1 z-50 w-max grid grid-cols-4 gap-1 p-1.5 bg-[#2a2a2a] border border-[#555] rounded-lg shadow-lg"
        >
          {KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              onMouseDown={keepFocus}
              onClick={(e) => {
                e.stopPropagation();
                onKey(appCursor && k.appSeq ? k.appSeq : k.seq);
              }}
              className="px-2 py-1.5 min-w-[44px] rounded bg-[#3a3a3a] active:bg-[#00d7d7] active:text-[#1e1e1e] text-[#e0e0e0] text-[12px] whitespace-nowrap"
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
