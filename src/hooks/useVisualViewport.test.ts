import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVisualViewport } from './useVisualViewport';

// The hook's whole job is to NOT react to every visualViewport event — each
// committed height change costs a pane_resize → SIGWINCH → full TUI repaint.
// These tests pin the constants that decide what gets through:
//   KEYBOARD_THRESHOLD_PX = 100   innerHeight - vv.height > 100 ⇒ keyboard up
//   QUICKTYPE_JITTER_PX   = 90    growth below this, keyboard up ⇒ ignored
//   SHRINK_DEBOUNCE_MS    = 120   shrinks always win, fast
//   GROW_DEBOUNCE_MS      = 250   growth waits out the close animation
//   ±4px                          deadband, neither shrink nor growth

const LAYOUT_HEIGHT = 768;

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  constructor(height: number) {
    super();
    this.height = height;
  }
  /** Move the visual viewport and fire the event the browser would fire. */
  resizeTo(height: number) {
    this.height = height;
    this.dispatchEvent(new Event('resize'));
  }
}

function installViewport(height: number | null): FakeVisualViewport | undefined {
  const vv = height === null ? undefined : new FakeVisualViewport(height);
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  return vv;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'innerHeight', {
    value: LAYOUT_HEIGHT,
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
});

describe('useVisualViewport — fallback when visualViewport is absent', () => {
  it('reports the layout viewport height and no keyboard', () => {
    installViewport(null);
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current).toEqual({ height: LAYOUT_HEIGHT, keyboardVisible: false });
  });

  it('stays keyboardVisible:false on window resize with no visualViewport', () => {
    installViewport(null);
    const { result } = renderHook(() => useVisualViewport());
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.keyboardVisible).toBe(false);
    expect(result.current.height).toBe(400);
  });
});

describe('useVisualViewport — initial measurement', () => {
  it('rounds a fractional visual viewport height', () => {
    installViewport(667.4);
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.height).toBe(667);
  });

  it('a 100px gap is NOT the keyboard — the threshold is exclusive', () => {
    installViewport(LAYOUT_HEIGHT - 100); // 668
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.keyboardVisible).toBe(false);
  });

  it('a 101px gap IS the keyboard', () => {
    installViewport(LAYOUT_HEIGHT - 101); // 667
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.keyboardVisible).toBe(true);
  });
});

describe('useVisualViewport — shrink commits fast (content must clear the keyboard)', () => {
  it('commits a shrink after 120ms, not before', () => {
    const vv = installViewport(LAYOUT_HEIGHT)!;
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.height).toBe(LAYOUT_HEIGHT);

    act(() => vv.resizeTo(400)); // keyboard opens
    act(() => vi.advanceTimersByTime(119));
    expect(result.current.height).toBe(LAYOUT_HEIGHT); // still debouncing

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toEqual({ height: 400, keyboardVisible: true });
  });

  it('coalesces a burst of shrinks into one commit at the final height', () => {
    const vv = installViewport(LAYOUT_HEIGHT)!;
    const { result } = renderHook(() => useVisualViewport());

    // iOS fires a stream of these during the keyboard animation.
    act(() => {
      vv.resizeTo(700);
      vi.advanceTimersByTime(30);
      vv.resizeTo(550);
      vi.advanceTimersByTime(30);
      vv.resizeTo(400);
    });
    expect(result.current.height).toBe(LAYOUT_HEIGHT); // nothing committed yet

    act(() => vi.advanceTimersByTime(120));
    expect(result.current.height).toBe(400); // one commit, final geometry
  });
});

describe('useVisualViewport — growth hysteresis', () => {
  /** Mount with the keyboard already up (committed height 400). */
  function withKeyboardUp() {
    const vv = installViewport(400)!;
    const hook = renderHook(() => useVisualViewport());
    expect(hook.result.current).toEqual({ height: 400, keyboardVisible: true });
    return { vv, result: hook.result };
  }

  it('IGNORES QuickType-sized growth while the keyboard is up', () => {
    const { vv, result } = withKeyboardUp();
    act(() => vv.resizeTo(450)); // +50px: the suggestion bar hiding
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.height).toBe(400); // settled layout held
  });

  it('ignores growth right up to the 90px jitter ceiling', () => {
    const { vv, result } = withKeyboardUp();
    act(() => vv.resizeTo(489)); // +89 < 90
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.height).toBe(400);
  });

  it('COMMITS growth at the jitter ceiling and above', () => {
    const { vv, result } = withKeyboardUp();
    act(() => vv.resizeTo(490)); // +90, not < 90
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.height).toBe(490);
  });

  it('commits a keyboard close after 250ms, not before', () => {
    const { vv, result } = withKeyboardUp();
    act(() => vv.resizeTo(LAYOUT_HEIGHT));
    act(() => vi.advanceTimersByTime(249));
    expect(result.current.height).toBe(400); // still waiting out the animation

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toEqual({ height: LAYOUT_HEIGHT, keyboardVisible: false });
  });

  it('does not apply the jitter rule when the keyboard was already down', () => {
    // Growth with the keyboard down (e.g. rotation) commits regardless of size.
    const vv = installViewport(700)!; // 68px gap: keyboard down
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.keyboardVisible).toBe(false);

    act(() => vv.resizeTo(740)); // +40, would be "jitter" if the keyboard were up
    act(() => vi.advanceTimersByTime(250));
    expect(result.current.height).toBe(740);
  });
});

describe('useVisualViewport — deadband', () => {
  it('ignores changes of 4px or less in either direction', () => {
    const vv = installViewport(LAYOUT_HEIGHT)!;
    const { result } = renderHook(() => useVisualViewport());

    act(() => vv.resizeTo(LAYOUT_HEIGHT + 4));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.height).toBe(LAYOUT_HEIGHT);

    act(() => vv.resizeTo(LAYOUT_HEIGHT - 4));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.height).toBe(LAYOUT_HEIGHT);
  });
});

describe('useVisualViewport — teardown', () => {
  it('removes its listeners so a late event cannot set state after unmount', () => {
    const vv = installViewport(LAYOUT_HEIGHT)!;
    const removeSpy = vi.spyOn(vv, 'removeEventListener');
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useVisualViewport());

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(winRemove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(winRemove).toHaveBeenCalledWith('orientationchange', expect.any(Function));
  });
});
