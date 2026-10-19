import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingControls } from './MeetingControls';
import { PaneBox } from './PaneBox';
import type { PaneSnapshot } from '../types';
import { useStore } from '../store';
import { resolveMeetingReply } from '../meeting/controls';

// E17 (k2), MTG-6: the meeting pane's lifecycle panel. Two meeting panes,
// two mocked meetings: a click on B's panel sends a command for B's meeting
// only, and B's reply changes B's panel only. No daemon, no live meeting.

const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
vi.mock('../utils/commands', () => ({
  sendCommand: (action: string, params?: Record<string, unknown>) => {
    sent.push({ action, params: params || {} });
  },
}));

// LiveKit's React layer, as in MeetingPaneView.test.tsx: never a real room.
vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RoomAudioRenderer: () => null,
  TrackToggle: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DisconnectButton: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  useParticipants: () => [],
  useDataChannel: () => ({}),
}));

function renderTwo() {
  return render(
    <>
      <div data-testid="A"><MeetingControls paneId="pa" meetingId="m-aaaaaa" /></div>
      <div data-testid="B"><MeetingControls paneId="pb" meetingId="m-bbbbbb" /></div>
    </>
  );
}

describe('MeetingControls', () => {
  beforeEach(() => {
    sent.length = 0;
    useStore.setState({ ws: { readyState: WebSocket.OPEN } as WebSocket });
  });
  afterEach(() => useStore.setState({ ws: null }));

  it('reads each meeting\'s pending turn and acts on its own meeting only', async () => {
    renderTwo();
    // Each panel asks for its own meeting's pending turn on mount.
    expect(sent).toEqual([
      { action: 'meeting_command', params: { id: 'm-aaaaaa', verb: 'pending' } },
      { action: 'meeting_command', params: { id: 'm-bbbbbb', verb: 'pending' } },
    ]);
    await act(async () => {
      resolveMeetingReply({ id: 'm-aaaaaa', verb: 'pending', reply: { state: 'listening', phase: 'listening' } });
      resolveMeetingReply({
        id: 'm-bbbbbb', verb: 'pending',
        reply: { state: 'awaiting_approval', turn_id: 't-b', speaker: 'Ana', agent: 'scribe', request: 'summarise the sprint' },
      });
    });

    const b = within(screen.getByTestId('B'));
    const a = within(screen.getByTestId('A'));
    expect(b.getByText(/awaiting_approval/)).toBeTruthy();
    expect(b.getByText(/Ana/)).toBeTruthy();
    expect(b.getByText(/summarise the sprint/)).toBeTruthy();
    expect(a.queryByRole('button', { name: 'Approve' })).toBeNull(); // nothing pending on A

    sent.length = 0;
    fireEvent.click(b.getByRole('button', { name: 'Approve' }));
    expect(sent).toEqual([{ action: 'meeting_command', params: { id: 'm-bbbbbb', verb: 'approve', turn_id: 't-b' } }]);

    await act(async () => {
      resolveMeetingReply({ id: 'm-bbbbbb', verb: 'approve', reply: { state: 'executing' } });
    });
    expect(b.getByText(/approve: executing/)).toBeTruthy();
    expect(a.queryByText(/approve:/)).toBeNull();

    sent.length = 0;
    fireEvent.click(a.getByRole('button', { name: 'Pause' }));
    expect(sent).toEqual([{ action: 'meeting_command', params: { id: 'm-aaaaaa', verb: 'pause' } }]);
  });

  it('shows the daemon error on the panel that asked', async () => {
    renderTwo();
    await act(async () => {
      resolveMeetingReply({ id: 'm-bbbbbb', verb: 'pending', reply: { state: 'awaiting_speech', turn_id: 't9' } });
    });
    const b = within(screen.getByTestId('B'));
    fireEvent.click(b.getByRole('button', { name: 'Speak' }));
    await act(async () => {
      resolveMeetingReply({ id: 'm-bbbbbb', verb: 'speak', error: 'turn t9 expired', reply: {} });
    });
    expect(b.getByText(/speak failed: turn t9 expired/)).toBeTruthy();
    expect(within(screen.getByTestId('A')).queryByText(/failed/)).toBeNull();
  });

  it('renders nothing actionable without a meeting id', () => {
    render(<MeetingControls paneId="px" meetingId="" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe('PaneBox meeting pane', () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  beforeEach(() => {
    sent.length = 0;
    useStore.setState({ ws: { readyState: WebSocket.OPEN } as WebSocket });
    const ok = vi.fn(async () => ({ success: true }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      webPane: { create: ok, navigate: ok, detach: ok, setBounds: ok, goBack: ok, goForward: ok, reload: ok },
    };
  });
  afterEach(() => useStore.setState({ ws: null }));

  it('mounts the bot controls under the meeting pane, for that pane\'s meeting', () => {
    const pane: PaneSnapshot = {
      id: 'pm1', title: 'meeting', flex: 1, mode: 'shell', output: '', status: 'running',
      last_command: '', provider_name: '', pane_type: 'meeting',
      meta: { 'meeting.id': 'm-3f9a2c', 'meeting.kind': 'web', 'meeting.platform': 'google_meet', 'meeting.url': 'https://meet.google.com/abc-defg-hij' },
    };
    render(<PaneBox pane={pane} isActive inputMode="shell" pipelineActive={false} />);
    expect(screen.getByLabelText('meeting bot controls')).toBeTruthy();
    expect(sent).toContainEqual({ action: 'meeting_command', params: { id: 'm-3f9a2c', verb: 'pending' } });
  });
});
