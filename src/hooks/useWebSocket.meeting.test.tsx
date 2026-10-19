import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';
import { useStore } from '../store';
import { sendMeetingCommand } from '../meeting/controls';

// E17 (k2), MTG-6: the `meeting_reply` frame from the daemon reaches the
// meeting panel's waiting request — the routing hook beside meeting_token.

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  sent: string[] = [];
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(s: string) { this.sent.push(s); }
  close() {}
}

describe('useWebSocket meeting_reply', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', Object.assign(FakeWebSocket, { OPEN: 1 }));
    useStore.setState({ sidecarPort: null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useStore.setState({ ws: null });
  });

  it('routes a meeting_reply frame to the request for that meeting and verb', async () => {
    const { unmount } = renderHook(() => useWebSocket());
    const ws = FakeWebSocket.last!;
    ws.onopen?.();
    useStore.setState({ ws: ws as unknown as WebSocket });

    const p = sendMeetingCommand('m-bbbbbb', 'pause');
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toEqual({
      type: 'command',
      data: { action: 'meeting_command', params: { id: 'm-bbbbbb', verb: 'pause' } },
    });
    ws.onmessage?.({ data: JSON.stringify({ type: 'meeting_reply', data: { id: 'm-bbbbbb', verb: 'pause', reply: { state: 'paused' } } }) });
    await expect(p).resolves.toMatchObject({ state: 'paused' });
    unmount();
  });
});
