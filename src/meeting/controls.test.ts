import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { resolveMeetingReply, sendMeetingCommand, panelVerbs } from './controls';

// E17 (k2), MTG-6: the app's half of the meeting-bot lifecycle controls.
// Every verb goes to the daemon as `meeting_command` {id, verb, turn_id},
// addressed by the meeting's registry id, and the `meeting_reply` frame is
// routed back by the id AND verb it echoes — so with two meetings open a
// reply for one can never answer the other.

const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
vi.mock('../utils/commands', () => ({
  sendCommand: (action: string, params?: Record<string, unknown>) => {
    sent.push({ action, params: params || {} });
  },
}));

describe('sendMeetingCommand', () => {
  beforeEach(() => {
    sent.length = 0;
    useStore.setState({ ws: { readyState: WebSocket.OPEN } as WebSocket });
  });
  afterEach(() => useStore.setState({ ws: null }));

  it('addresses each command to its own meeting and routes replies by id and verb', async () => {
    const a = sendMeetingCommand('m-aaaaaa', 'pause');
    const b = sendMeetingCommand('m-bbbbbb', 'approve', 't-b');
    expect(sent).toEqual([
      { action: 'meeting_command', params: { id: 'm-aaaaaa', verb: 'pause' } },
      { action: 'meeting_command', params: { id: 'm-bbbbbb', verb: 'approve', turn_id: 't-b' } },
    ]);

    let aSettled = false;
    a.then(() => (aSettled = true), () => (aSettled = true));
    // B's reply, and a reply for A with the wrong verb, must not settle A.
    resolveMeetingReply({ id: 'm-bbbbbb', verb: 'approve', reply: { state: 'executing', turn_id: 't-b' } });
    resolveMeetingReply({ id: 'm-aaaaaa', verb: 'approve', reply: { state: 'nope' } });
    await expect(b).resolves.toMatchObject({ state: 'executing', turn_id: 't-b' });
    await Promise.resolve();
    expect(aSettled).toBe(false);

    resolveMeetingReply({ id: 'm-aaaaaa', verb: 'pause', reply: { state: 'paused' } });
    await expect(a).resolves.toMatchObject({ state: 'paused' });
  });

  it("rejects with the daemon's error", async () => {
    const p = sendMeetingCommand('m-aaaaaa', 'speak', 't1');
    resolveMeetingReply({ id: 'm-aaaaaa', verb: 'speak', error: 'turn t1 expired', reply: {} });
    await expect(p).rejects.toThrow(/turn t1 expired/);
  });

  it('refuses a bad id, a verb outside the seven, or a closed socket, without sending', async () => {
    await expect(sendMeetingCommand('', 'pause')).rejects.toThrow(/meeting id/);
    await expect(sendMeetingCommand('meeting-1', 'pause')).rejects.toThrow(/meeting id/);
    // @ts-expect-error — leave is not a panel verb
    await expect(sendMeetingCommand('m-aaaaaa', 'leave')).rejects.toThrow(/not a meeting panel control/);
    useStore.setState({ ws: null });
    await expect(sendMeetingCommand('m-aaaaaa', 'pause')).rejects.toThrow(/Not connected/);
    expect(sent).toEqual([]);
  });
});

describe('panelVerbs', () => {
  it('offers the verbs the bot state allows', () => {
    expect(panelVerbs({ state: 'awaiting_approval', turn_id: 't' })).toEqual(['approve', 'reject', 'pause', 'cancel']);
    expect(panelVerbs({ state: 'awaiting_speech', turn_id: 't' })).toEqual(['speak', 'reject', 'pause', 'cancel']);
    expect(panelVerbs({ state: 'paused' })).toEqual(['resume', 'cancel']);
    expect(panelVerbs({ state: 'listening' })).toEqual(['pause', 'cancel']);
    expect(panelVerbs(undefined)).toEqual([]);
  });
});
