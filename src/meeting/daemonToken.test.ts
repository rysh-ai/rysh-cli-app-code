import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { requestMeetingToken, requestRoomToken, resolveMeetingToken } from './daemonToken';

// E-87: room requests (no pane) share the meeting_token path with pane
// requests and are routed back by the room the daemon echoes.

const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
vi.mock('../utils/commands', () => ({
  sendCommand: (action: string, params?: Record<string, unknown>) => {
    sent.push({ action, params: params || {} });
  },
}));

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2ln';

describe('requestRoomToken', () => {
  beforeEach(() => {
    sent.length = 0;
    useStore.setState({ ws: { readyState: WebSocket.OPEN } as WebSocket });
  });
  afterEach(() => useStore.setState({ ws: null }));

  it('asks the daemon by room and resolves on the echoed room only', async () => {
    const p = requestRoomToken('standup');
    expect(sent).toEqual([{ action: 'meeting_token', params: { room: 'standup' } }]);
    expect(requestRoomToken('standup')).toBe(p); // one in flight per room
    // A pane reply never answers a room request, even for the same name.
    resolveMeetingToken({ pane_id: 'standup', url: 'wss://lk.example', token: JWT });
    resolveMeetingToken({ pane_id: '', room: 'other', url: 'wss://lk.example', token: JWT });
    resolveMeetingToken({ pane_id: '', room: 'standup', url: 'wss://lk.example', token: JWT, identity: 'u1' });
    await expect(p).resolves.toEqual({ url: 'wss://lk.example', token: JWT, identity: 'u1', room: 'standup' });
  });

  it('a room reply never answers a pane request', async () => {
    const pane = requestMeetingToken('pm1');
    resolveMeetingToken({ pane_id: '', room: 'pm1', url: 'wss://lk.example', token: JWT });
    resolveMeetingToken({ pane_id: 'pm1', url: 'wss://lk.example', token: JWT });
    await expect(pane).resolves.toMatchObject({ token: JWT });
  });

  it('refuses a bad room id or a closed socket without sending', async () => {
    await expect(requestRoomToken('bad room!')).rejects.toThrow(/Room ids/);
    useStore.setState({ ws: null });
    await expect(requestRoomToken('standup2')).rejects.toThrow(/Not connected/);
    expect(sent).toEqual([]);
  });

  it("passes the daemon's error and rejects a non-wss grant", async () => {
    const a = requestRoomToken('gone');
    resolveMeetingToken({ pane_id: '', room: 'gone', error: 'token: the room has ended or expired' });
    await expect(a).rejects.toThrow(/ended/);
    const b = requestRoomToken('evil');
    resolveMeetingToken({ pane_id: '', room: 'evil', url: 'ws://evil.example', token: JWT });
    await expect(b).rejects.toThrow(/wss/);
  });
});
