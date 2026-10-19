import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { VTScreen } from '../components/VTScreen';
import { usePaneResize } from '../hooks/usePaneResize';

// Design 018 §5 gap 5: terminal cell metrics had three owners. usePaneResize
// (PTY rows/cols) and VTScreen (cursor-follow scroll offset) each hardcoded
// 13px × 1.2, while the wheel path read the real .vt-screen font. Change the
// font in CSS and the PTY grid, the scroll offset and the screen stop agreeing.
// These tests change the .vt-screen font size the way a stylesheet would and
// require every consumer to follow it — and pin today's 13px numbers.

const sendCommand = vi.fn();
vi.mock('./commands', async (orig) => ({
  ...(await orig<typeof import('./commands')>()),
  sendCommand: (...args: unknown[]) => sendCommand(...args),
}));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let style: HTMLStyleElement | null = null;
function setVTFontSize(px: number) {
  style = document.createElement('style');
  style.textContent = `.vt-screen { font-size: ${px}px; line-height: 1.2; }`;
  document.head.appendChild(style);
}

// The box both consumers are measured against: 204px tall → 200px of rows
// after .vt-screen's 2px+2px vertical padding.
const BOX_H = 204;
const VIEW_H = BOX_H - 4;

let clientHeight: PropertyDescriptor | undefined;
beforeEach(() => {
  clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('vt-screen') ? BOX_H : 0;
    },
  });
});
afterEach(() => {
  style?.remove();
  style = null;
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
  sendCommand.mockReset();
});

/** Rows the resize hook claims for a BOX_H-tall, 400px-wide content box. */
function resizeClaim(): { rows: number; cols: number } {
  function Probe() {
    const ref = usePaneResize('p1');
    return (
      <div
        ref={(el) => {
          if (el) el.getBoundingClientRect = () => ({ width: 400, height: BOX_H } as DOMRect);
          ref(el);
        }}
      />
    );
  }
  const { unmount } = render(<Probe />);
  unmount();
  const calls = sendCommand.mock.calls.filter(([a]) => a === 'pane_resize');
  expect(calls.length).toBeGreaterThan(0);
  const { rows, cols } = calls[calls.length - 1][1] as { rows: number; cols: number };
  return { rows, cols };
}

/** VTScreen's cursor-follow offset (px) for 40 lines with the cursor on row 20. */
function followOffset(): number {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const { container, unmount } = render(<VTScreen lines={lines} cursorRow={20} />);
  const inner = container.querySelector('.vt-screen > div') as HTMLElement;
  const m = /translateY\((-?[\d.]+)px\)/.exec(inner.style.transform);
  unmount();
  return m ? -parseFloat(m[1]) : 0;
}

/** The offset VTScreen must produce for a cell height h (its own formula). */
function expectedOffset(h: number): number {
  const contentH = 40 * h;
  const offset = (20 + 1) * h + h - VIEW_H;
  return Math.min(Math.max(offset, 0), contentH - VIEW_H);
}

describe('cell metrics — every consumer follows the .vt-screen font', () => {
  it('at 20px, the resize hook claims PTY rows of a 24px cell', () => {
    setVTFontSize(20);
    expect(resizeClaim().rows).toBe(Math.floor(VIEW_H / 24)); // 8
  });

  it('at 20px, VTScreen offsets the cursor by the same 24px cell', () => {
    setVTFontSize(20);
    expect(followOffset()).toBeCloseTo(expectedOffset(24), 6); // 328
  });
});

describe('cell metrics — today\'s 13px numbers are unchanged', () => {
  it('uses h = 15.6 for the PTY rows and the cursor-follow offset', () => {
    setVTFontSize(13);
    expect(resizeClaim().rows).toBe(Math.floor(VIEW_H / 15.6)); // 12
    expect(followOffset()).toBeCloseTo(expectedOffset(15.6), 6); // 143.2
  });

  it('falls back to a 7.8px cell width when the probe measures nothing', () => {
    // jsdom has no layout, so the width probe measures 0 — exactly the
    // "measured before fonts are ready" case the fallback exists for.
    setVTFontSize(13);
    const { rows, cols } = resizeClaim();
    expect(rows).toBe(Math.floor(VIEW_H / 15.6)); // 12
    expect(cols).toBe(Math.floor((400 - 8) / 7.8)); // 50
    expect(followOffset()).toBeCloseTo(expectedOffset(15.6), 6);
  });
});
