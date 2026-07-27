import { useEffect, useState } from 'react';

// useVisualViewport — web analog of rysh-mobile's useKeyboard hook (RN
// Keyboard show/hide listeners) + its KeyboardAvoidingView. On the mobile web
// there is no keyboard event; the signal is the VisualViewport API: when the
// soft keyboard opens, visualViewport.height shrinks while the layout
// viewport (window.innerHeight on iOS) stays put. Whoever sizes the mobile
// pane view to `height` px therefore shrinks above the keyboard — which is
// exactly what rysh-mobile's KeyboardAvoidingView padding did — and the
// existing usePaneResize ResizeObserver then re-fits the PTY to the smaller
// area so the interactive app redraws with its input line on screen.
//
// STABILITY MATTERS MORE THAN FIDELITY here: every committed height change
// cascades into a pane_resize → SIGWINCH → full TUI repaint of the
// interactive app. iOS fires a stream of visualViewport resizes during the
// keyboard animation, and the QuickType suggestion bar grows/shrinks per
// word typed — naively tracking each event meant claude was repainting
// mid-keystroke constantly, so the input line was permanently a half-painted
// mess of stale and fresh cells. Hysteresis rules:
//
//   - shrink → commit (fast debounce): content must never sit under the
//     keyboard, so height decreases always win.
//   - small growth while the keyboard is up (< QUICKTYPE_JITTER_PX, e.g. the
//     QuickType bar hiding) → IGNORED: we keep the smaller, settled layout
//     instead of reflowing the terminal for ~50px that will bounce right
//     back on the next keystroke.
//   - large growth (keyboard closing, rotation) → commit (debounced past the
//     close animation).
const KEYBOARD_THRESHOLD_PX = 100;
// Height growth below this, while the keyboard is up, is treated as
// suggestion-bar jitter and ignored. iOS QuickType is ~45–55px.
const QUICKTYPE_JITTER_PX = 90;
const SHRINK_DEBOUNCE_MS = 120;
const GROW_DEBOUNCE_MS = 250;

export interface VisualViewportState {
  /** Best-known visible viewport height in CSS px (0 until first measure). */
  height: number;
  /** True while the soft keyboard overlays the layout viewport. */
  keyboardVisible: boolean;
}

function read(): VisualViewportState {
  const vv = window.visualViewport;
  if (!vv) {
    return { height: window.innerHeight, keyboardVisible: false };
  }
  return {
    height: Math.round(vv.height),
    keyboardVisible: window.innerHeight - vv.height > KEYBOARD_THRESHOLD_PX,
  };
}

export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(() =>
    typeof window === 'undefined' ? { height: 0, keyboardVisible: false } : read()
  );

  useEffect(() => {
    const vv = window.visualViewport;
    let committed = read();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const commit = () => {
      timer = null;
      const next = read(); // re-read at fire time: latest geometry wins
      // iOS pans the page to reveal the focused element when the keyboard
      // opens; with the view sized to the visual viewport the element is
      // already above the keyboard, so undo the pan to keep the top bar
      // on screen.
      if (next.keyboardVisible && (window.scrollY > 0 || (vv?.offsetTop ?? 0) > 0)) {
        window.scrollTo(0, 0);
      }
      if (next.height === committed.height && next.keyboardVisible === committed.keyboardVisible) {
        return;
      }
      committed = next;
      setState(next);
    };

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(commit, ms);
    };

    const update = () => {
      const raw = read();
      const delta = raw.height - committed.height;
      if (delta < -4) {
        schedule(SHRINK_DEBOUNCE_MS);
      } else if (delta > 4) {
        if (committed.keyboardVisible && raw.keyboardVisible && delta < QUICKTYPE_JITTER_PX) {
          return; // QuickType bar hid — hold the settled layout
        }
        schedule(GROW_DEBOUNCE_MS);
      } else if (raw.keyboardVisible !== committed.keyboardVisible) {
        schedule(SHRINK_DEBOUNCE_MS);
      }
    };

    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      if (timer) clearTimeout(timer);
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return state;
}
