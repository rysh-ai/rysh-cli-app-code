import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParticipantKind } from 'livekit-client';

// LiveKit's React layer is replaced by a small fake: the room records its
// props, useParticipants returns the fixture list, useDataChannel captures the
// message handler so a test can deliver data packets.
const lk = vi.hoisted(() => ({
  participants: [] as unknown[],
  onData: undefined as undefined | ((m: { payload: Uint8Array; from?: unknown }) => void),
  topic: '',
  roomProps: undefined as undefined | Record<string, unknown>,
  audioMuted: undefined as undefined | boolean,
}));
vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: (props: Record<string, unknown> & { children: React.ReactNode }) => {
    lk.roomProps = props;
    return <div data-testid="room">{props.children}</div>;
  },
  RoomAudioRenderer: ({ muted }: { muted?: boolean }) => {
    lk.audioMuted = muted;
    return null;
  },
  TrackToggle: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DisconnectButton: ({ children }: { children: React.ReactNode }) => (
    <button onClick={() => (lk.roomProps?.onDisconnected as () => void)()}>{children}</button>
  ),
  useParticipants: () => lk.participants,
  useDataChannel: (topic: string, cb: (m: { payload: Uint8Array; from?: unknown }) => void) => {
    lk.topic = topic;
    lk.onData = cb;
    return {};
  },
}));

import { BotWall, JoinForm, MeetingPanel, isAgent, ParticipantList } from './MeetingPanel';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2ln';
const bot = { identity: 'rysh-bot', name: 'Rysh', kind: ParticipantKind.AGENT, attributes: {}, isSpeaking: false, isMicrophoneEnabled: true, isLocal: false };
const ada = { identity: 'user:1', name: 'Ada', kind: ParticipantKind.STANDARD, attributes: {}, isSpeaking: true, isMicrophoneEnabled: false, isLocal: true };
const send = (from: unknown, msg: unknown) =>
  act(() => lk.onData!({ payload: new TextEncoder().encode(JSON.stringify(msg)), from }));

beforeEach(() => {
  // jsdom has no modal dialogs; same stub as FaceTimePanel.test.tsx.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  lk.participants = [];
  lk.onData = undefined;
  lk.roomProps = undefined;
});
afterEach(() => vi.useRealTimers());

describe('isAgent', () => {
  it('trusts the token kind, with the rysh.kind attribute as fallback', () => {
    expect(isAgent(bot)).toBe(true);
    expect(isAgent(ada)).toBe(false);
    expect(isAgent({ kind: ParticipantKind.STANDARD, attributes: { 'rysh.kind': 'agent' } })).toBe(true);
    expect(isAgent({ kind: ParticipantKind.STANDARD, attributes: { 'rysh.kind': 'account', 'rysh.role': 'owner' } })).toBe(false);
  });
});

describe('JoinForm', () => {
  it('joins from a pasted link', () => {
    const onJoin = vi.fn();
    render(<JoinForm onJoin={onJoin} />);
    fireEvent.change(screen.getByLabelText(/Join link/), {
      target: { value: `https://rysh.ai/meet?url=wss://lk.rysh.ai&token=${JWT}&room=standup` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).toHaveBeenCalledWith({ url: 'wss://lk.rysh.ai', token: JWT, room: 'standup' });
  });

  it('joins from a server URL and token, and explains a bad one', () => {
    const onJoin = vi.fn();
    render(<JoinForm onJoin={onJoin} />);
    fireEvent.change(screen.getByLabelText('LiveKit server URL'), { target: { value: 'ws://evil.example' } });
    fireEvent.change(screen.getByLabelText('Join token'), { target: { value: JWT } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/wss/);
    fireEvent.change(screen.getByLabelText('LiveKit server URL'), { target: { value: 'ws://localhost:7880' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).toHaveBeenCalledWith({ url: 'ws://localhost:7880', token: JWT });
  });

  it('gets a token from the account source (mocked LK-3 endpoint)', async () => {
    const onJoin = vi.fn();
    const source = vi.fn(async () => ({ url: 'wss://lk.rysh.ai', token: JWT, identity: 'user:1' }));
    render(<JoinForm onJoin={onJoin} tokenSource={source} />);
    const join = screen.getAllByRole('button', { name: 'Join' })[0];
    expect(join).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Room/), { target: { value: 'standup' } });
    await act(async () => fireEvent.click(join));
    expect(source).toHaveBeenCalledWith('standup');
    expect(onJoin).toHaveBeenCalledWith({ room: 'standup', url: 'wss://lk.rysh.ai', token: JWT, identity: 'user:1' });
  });

  it('shows the account source error', async () => {
    const source = vi.fn(async () => {
      throw new Error('Your account may not join this room.');
    });
    render(<JoinForm onJoin={vi.fn()} tokenSource={source} />);
    fireEvent.change(screen.getByLabelText(/Room/), { target: { value: 'standup' } });
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Join' })[0]));
    expect(screen.getByRole('alert').textContent).toMatch(/may not join/);
  });
});

describe('in the room', () => {
  it('connects with the grant, mic off by default, and leaving returns to the form', () => {
    render(<MeetingPanel onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Join link/), {
      target: { value: `https://rysh.ai/meet?url=wss://lk.rysh.ai&token=${JWT}&room=standup` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(lk.roomProps).toMatchObject({ serverUrl: 'wss://lk.rysh.ai', token: JWT, connect: true, audio: false, video: false });
    expect(screen.getByText(/Rysh meeting — standup/)).toBeInTheDocument();
    expect(lk.audioMuted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Speaker on' }));
    expect(lk.audioMuted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.getByText('You left the meeting.')).toBeInTheDocument();
  });

  it('lists participants with the bot marked as AI', () => {
    lk.participants = [ada, bot];
    render(<ParticipantList />);
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toMatch(/Ada\(you\)muted/);
    expect(items[1].textContent).toMatch(/RyshAI/);
  });
});

describe('BotWall', () => {
  it('waits for the bot, then follows its phases on the rysh.wall topic', () => {
    vi.useFakeTimers();
    const { rerender } = render(<BotWall />);
    expect(screen.getByLabelText('Rysh bot').textContent).toMatch(/Waiting for the rysh bot/);
    expect(lk.topic).toBe('rysh.wall');
    lk.participants = [bot];
    rerender(<BotWall />);
    send(bot, { type: 'status', phase: 'heard', speaker: 'Ada', request: 'what changed today', elapsed_ms: 1000 });
    expect(screen.getByText('Hearing your request')).toBeInTheDocument();
    expect(screen.getByText('“what changed today”')).toBeInTheDocument();
    expect(screen.getByTestId('wall-elapsed').textContent).toBe('0:01');
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByTestId('wall-elapsed').textContent).toBe('0:04');
    send(bot, { type: 'status', phase: 'thinking', agent: 'scribe', speaker: 'Ada', request: 'what changed today' });
    expect(screen.getByText('Scribe is working on it')).toBeInTheDocument();
    send(bot, { type: 'status', phase: 'speaking', speaker: 'Ada', request: 'what changed today', caption: 'Two commits.' });
    expect(screen.getByText('Two commits.')).toBeInTheDocument();
    send(bot, { type: 'status', phase: 'listening' });
    expect(screen.getByLabelText('Rysh bot Rysh').getAttribute('data-phase')).toBe('listening');
    expect(screen.queryByText('Two commits.')).toBeNull();
    expect(screen.queryByText(/Answering/)).toBeNull();
  });

  it('ignores wall messages from anyone but the bot, and malformed packets', () => {
    lk.participants = [ada, bot];
    render(<BotWall />);
    send(ada, { type: 'status', phase: 'speaking', caption: 'I am the bot now' });
    send(undefined, { type: 'status', phase: 'speaking', caption: 'server-sent' });
    act(() => lk.onData!({ payload: new TextEncoder().encode('{bad'), from: bot }));
    expect(screen.getByLabelText('Rysh bot Rysh').textContent).toBe('Rysh is in the room');
  });

  it('names the bot once it is in the room', () => {
    lk.participants = [bot];
    render(<BotWall />);
    expect(screen.getByLabelText('Rysh bot Rysh').textContent).toBe('Rysh is in the room');
  });

  // Design 043 D9: two agents are two bots, each with its own wall.
  it('gives every agent bot its own wall, and drops the wall of a bot that left', () => {
    const scribe = { ...bot, identity: 'agent-scribe', name: 'scribe' };
    const planner = { ...bot, identity: 'agent-planner', name: 'planner' };
    lk.participants = [ada, scribe, planner];
    const { rerender } = render(<BotWall />);
    send(scribe, { type: 'status', phase: 'listening', agent: 'scribe' });
    send(planner, { type: 'status', phase: 'thinking', agent: 'planner', speaker: 'Ada', request: 'plan the week' });
    expect(screen.getByLabelText('Rysh bot scribe').textContent).toMatch(/Say “hey scribe”/);
    expect(screen.getByLabelText('Rysh bot planner').textContent).toMatch(/Planner is working on it/);
    send(scribe, { type: 'status', phase: 'speaking', agent: 'scribe', speaker: 'Ada', request: 'notes', caption: 'Noted.' });
    expect(screen.getByLabelText('Rysh bot scribe').getAttribute('data-phase')).toBe('speaking');
    expect(screen.getByLabelText('Rysh bot planner').getAttribute('data-phase')).toBe('thinking');
    lk.participants = [ada, planner];
    rerender(<BotWall />);
    expect(screen.queryByLabelText('Rysh bot scribe')).toBeNull();
    expect(screen.getByLabelText('Rysh bot planner')).toBeInTheDocument();
  });
});
