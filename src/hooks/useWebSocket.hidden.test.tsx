import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';
import { useStore } from '../store';

// Browsers stop running requestAnimationFrame callbacks in a hidden tab. The
// output flush was scheduled only through rAF, so while a tab sat in the
// background every pane's output piled up unflushed and unbounded — for hours
// or days — and then landed in one frame when the tab came back, freezing it.

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string) { FakeWebSocket.last = this; }
  send() {}
  close() {}
}

describe('useWebSocket output flush in a hidden tab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    // rAF never fires, exactly as in a background tab.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    useStore.setState({ paneContent: {}, sidecarPort: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('flushes on a timer, and keeps only the capped tail', () => {
    const { unmount } = renderHook(() => useWebSocket());
    const ws = FakeWebSocket.last!;
    ws.onopen?.();
    const chunk = 'x'.repeat(999) + '\n';
    for (let i = 0; i < 100; i++) {
      ws.onmessage?.({ data: JSON.stringify({ type: 'pane_output', data: { pane_id: 'p1', mode: 'shell', text: chunk } }) });
    }
    expect(useStore.getState().paneContent.p1).toBeUndefined(); // queued, not yet flushed

    vi.advanceTimersByTime(600);
    const out = useStore.getState().paneContent.p1?.output ?? '';
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(20_000);
    unmount();
  });
});

describe('useWebSocket pane_content supersedes queued output', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    useStore.setState({ paneContent: {}, sidecarPort: null });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  // A pane coming on screen gets a catch-up of its current content. Output for
  // it that arrived just before and is still queued is already inside that
  // content; flushing it afterwards would print it twice.
  it('does not print queued output twice after a catch-up', () => {
    const { unmount } = renderHook(() => useWebSocket());
    const ws = FakeWebSocket.last!;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ type: 'pane_output', data: { pane_id: 'p1', mode: 'shell', text: 'line 2\n' } }) });
    ws.onmessage?.({ data: JSON.stringify({ type: 'pane_content', data: { panes: [{ pane_id: 'p1', output: 'line 1\nline 2\n' }] } }) });
    ws.onmessage?.({ data: JSON.stringify({ type: 'pane_output', data: { pane_id: 'p1', mode: 'shell', text: 'line 3\n' } }) });
    vi.advanceTimersByTime(600);
    expect(useStore.getState().paneContent.p1?.output).toBe('line 1\nline 2\nline 3\n');
    unmount();
  });
});
