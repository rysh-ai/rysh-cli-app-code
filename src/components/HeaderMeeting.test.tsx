import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from './Header';
import { useStore } from '../store';
import { resolveMeetingToken } from '../meeting/daemonToken';

// E-87: the header's Meeting panel joins a rysh room by id with a token the
// DAEMON mints from its own rysh key (meeting_token with a room and no pane).
// The app holds no account credential and calls no rysh server itself.

const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
vi.mock('../utils/commands', () => ({
  sendCommand: (action: string, params?: Record<string, unknown>) => {
    sent.push({ action, params: params || {} });
  },
}));

const lk = vi.hoisted(() => ({ roomProps: undefined as undefined | Record<string, unknown> }));
vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: (props: Record<string, unknown> & { children: React.ReactNode }) => {
    lk.roomProps = props;
    return <div data-testid="room">{props.children}</div>;
  },
  RoomAudioRenderer: () => null,
  TrackToggle: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DisconnectButton: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  useParticipants: () => [],
  useDataChannel: () => ({}),
}));

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2ln';

describe('Header Meeting panel (E-87)', () => {
  beforeAll(() => {
    // jsdom has no <dialog> methods.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
  });
  beforeEach(() => {
    sent.length = 0;
    lk.roomProps = undefined;
    useStore.setState({ ws: { readyState: WebSocket.OPEN } as WebSocket });
  });
  afterEach(() => {
    useStore.setState({ ws: null });
  });

  it('joins a room by id with a token from the daemon', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<Header />);
    fireEvent.click(screen.getByRole('button', { name: 'Meeting' }));
    const input = await screen.findByLabelText(/Room id/);
    fireEvent.change(input, { target: { value: 'room9' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(sent).toContainEqual({ action: 'meeting_token', params: { room: 'room9' } }));
    act(() => resolveMeetingToken({ pane_id: '', room: 'room9', url: 'wss://lk.example', token: JWT, identity: 'u1' }));

    await screen.findByTestId('room');
    expect(lk.roomProps?.serverUrl).toBe('wss://lk.example');
    expect(lk.roomProps?.token).toBe(JWT);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("shows the daemon's error and stays on the form", async () => {
    render(<Header />);
    fireEvent.click(screen.getByRole('button', { name: 'Meeting' }));
    const input = await screen.findByLabelText(/Room id/);
    fireEvent.change(input, { target: { value: 'gone' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(sent).toContainEqual({ action: 'meeting_token', params: { room: 'gone' } }));
    act(() => resolveMeetingToken({ pane_id: '', room: 'gone', error: 'token: the room has ended or expired' }));
    await screen.findByText(/ended or expired/);
    expect(screen.queryByTestId('room')).toBeNull();
  });
});
