import React, { forwardRef, useCallback, useRef } from 'react';

// TouchTermInput — soft-keyboard bridge for live interactive (VT) panes on
// touch devices. Port of rysh-mobile's InteractiveTerminal mechanism: there,
// xterm.js pops the phone keyboard because tapping the terminal focuses a
// real visually-hidden textarea (.xterm-helper-textarea) from inside the tap
// gesture, and every character the keyboard produces is forwarded to the PTY
// as raw bytes. The web renderer draws the VT screen itself and captures
// desktop keystrokes on `document`, so without this there is nothing
// focusable — a phone tap has no input to focus and the keyboard never
// appears.
//
// This component is that hidden textarea. PaneBox mounts it (touch devices
// only) alongside the VT screen and focuses it when the screen or the footer
// bar is tapped; the focus call happens synchronously inside the tap handler,
// which is what makes mobile Safari/Chrome raise the keyboard. Keystrokes are
// delivered through two paths, because soft keyboards differ:
//   - keydown with a real e.key (iOS, hardware keys): mapped via keyToBytes
//     and preventDefault'ed, same encoding as the desktop document handler.
//   - IME input (Android Gboard sends key='Unidentified'/keyCode 229):
//     beforeinput carries the text — insertText/insertLineBreak/
//     deleteContentBackward are translated and preventDefault'ed, so the
//     textarea stays empty. Composition (autocomplete, dead keys, CJK) is
//     left alone until compositionend, then the composed text is sent and
//     the textarea cleared.
//
// The textarea never holds state: it exists only to be focusable and to
// emit events. font-size must stay ≥16px — iOS zooms the page when a
// smaller input gains focus.

export interface TermEcho {
  kind: 'text' | 'backspace' | 'other';
  text?: string;
}

interface Props {
  /** Forward raw bytes to the PTY (local raw_key_input or remote forward). */
  onBytes: (bytes: number[], echo: TermEcho) => void;
  /** Same key→bytes mapping the desktop document handler uses. */
  keyToBytes: (e: KeyboardEvent) => number[] | null;
}

function textToBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

export const TouchTermInput = forwardRef<HTMLTextAreaElement, Props>(
  function TouchTermInput({ onBytes, keyToBytes }, ref) {
    const composingRef = useRef(false);

    const sendText = useCallback(
      (text: string) => {
        if (!text) return;
        onBytes(textToBytes(text), { kind: 'text', text });
      },
      [onBytes]
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // IME-managed keys: keyCode 229 / 'Unidentified' / 'Process' carry no
        // usable key — the real text arrives via beforeinput/composition.
        if (
          composingRef.current ||
          e.nativeEvent.isComposing ||
          e.keyCode === 229 ||
          e.key === 'Unidentified' ||
          e.key === 'Process'
        ) {
          return;
        }
        const bytes = keyToBytes(e.nativeEvent);
        if (!bytes) return; // multiplexer chords: leave to the global handler
        e.preventDefault();
        e.stopPropagation();
        const echo: TermEcho =
          e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
            ? { kind: 'text', text: e.key }
            : e.key === 'Backspace'
              ? { kind: 'backspace' }
              : { kind: 'other' };
        onBytes(bytes, echo);
      },
      [onBytes, keyToBytes]
    );

    const handleBeforeInput = useCallback(
      (e: React.FormEvent<HTMLTextAreaElement>) => {
        const ie = e.nativeEvent as InputEvent;
        if (composingRef.current || ie.isComposing) return;
        switch (ie.inputType) {
          case 'insertText':
          case 'insertFromPaste':
          case 'insertFromDrop':
            e.preventDefault();
            sendText(ie.data ?? '');
            break;
          case 'insertLineBreak':
            e.preventDefault();
            onBytes([13], { kind: 'other' });
            break;
          case 'deleteContentBackward':
            e.preventDefault();
            onBytes([127], { kind: 'backspace' });
            break;
          default:
            // Unhandled inputTypes fall through to onInput's drain below.
            break;
        }
      },
      [onBytes, sendText]
    );

    // Safety net: anything that still landed in the textarea (browsers that
    // skip beforeinput for some paths) is drained, sent, and cleared.
    const handleInput = useCallback(
      (e: React.FormEvent<HTMLTextAreaElement>) => {
        if (composingRef.current) return;
        const el = e.currentTarget;
        if (el.value) {
          sendText(el.value);
          el.value = '';
        }
      },
      [sendText]
    );

    const handleCompositionStart = useCallback(() => {
      composingRef.current = true;
    }, []);

    const handleCompositionEnd = useCallback(
      (e: React.CompositionEvent<HTMLTextAreaElement>) => {
        composingRef.current = false;
        sendText(e.data);
        e.currentTarget.value = '';
      },
      [sendText]
    );

    return (
      <textarea
        ref={ref}
        // Visually hidden but focusable. Not display:none / visibility:hidden
        // (unfocusable) and not width 0 (iOS refuses the keyboard). 16px font
        // prevents the iOS focus-zoom.
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: '1px',
          height: '1px',
          padding: 0,
          border: 'none',
          opacity: 0,
          fontSize: '16px',
          zIndex: -1,
          resize: 'none',
        }}
        aria-label="terminal input"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={handleKeyDown}
        onBeforeInput={handleBeforeInput}
        onInput={handleInput}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
      />
    );
  }
);
