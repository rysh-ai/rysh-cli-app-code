import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneBox } from './PaneBox';
import { MeetingPaneView } from './MeetingPaneView';
import { useStore } from '../store';
import { resolveMeetingToken } from '../meeting/daemonToken';
import type { PaneSnapshot } from '../types';

// Design 043 PM-2a/PM-4: the desktop app's half of a `##meeting join` pane.

// The daemon WebSocket is replaced by a recorder: every command the app sends
// lands in `sent` with its parsed params.
const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
vi.mock('../utils/commands', () => ({
  sendCommand: (action: string, params?: Record<string, unknown>) => {
    sent.push({ action, params: params || {} });
  },
}));

// LiveKit's React layer: a fake room that records the props it was given.
const lk = vi.hoisted(() => ({ roomProps: undefined as undefined | Record<string, unknown> }));
vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: (props: Record<string, unknown> & { children: React.ReactNode }) => {
    lk.roomProps = props;
    return <div data-testid="room">{props.children}</div>;
  },
  RoomAudioRenderer: () => null,
  TrackToggle: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DisconnectButton: ({ children }: { children: React.ReactNode }) => (
    <button onClick={() => (lk.roomProps?.onDisconnected as () => void)()}>{children}</button>
  ),
  useParticipants: () => [],
  useDataChannel: () => ({}),
}));

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2ln';

const webMeta = {
  'meeting.id': 'm-3f9a2c',
  'meeting.kind': 'web',
  'meeting.platform': 'meet',
  'meeting.url': 'https://meet.google.com/abc-defg-hij',
  'meeting.profile': 'work',
  'meeting.agents': 'ada, bob',
  'meeting.bot': 'in_call',
};
const lkMeta = {
  'meeting.id': 'm-00ab12',
  'meeting.kind': 'livekit',
  'meeting.platform': 'livekit',
  'meeting.url': 'https://rysh.ai/meet/standup',
  'meeting.room': 'standup',
  'meeting.server': 'https://rysh.ai',
};

function meetingPane(meta: Record<string, string>): PaneSnapshot {
  return {
    id: 'pm1',
    title: 'meeting',
    flex: 1,
    mode: 'shell',
    output: 'stale text that must not show',
    status: 'running',
    last_command: '',
    provider_name: '',
    pane_type: 'meeting',
    meta,
  };
}

function webPaneApi() {
  const api = {
    create: vi.fn(async () => ({ success: true })),
    navigate: vi.fn(async () => ({ success: true })),
    detach: vi.fn(async () => ({ success: true })),
    setBounds: vi.fn(async () => ({ success: true })),
    goBack: vi.fn(async () => ({ success: true })),
    goForward: vi.fn(async () => ({ success: true })),
    reload: vi.fn(async () => ({ success: true })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { webPane: api };
  return api;
}

/** A socket that looks open; sendCommand is mocked, so nothing is written. */
function openSocket() {
  act(() => {
    useStore.setState({ ws: { readyState: WebSocket.OPEN } as WebSocket });
  });
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  sent.length = 0;
  lk.roomProps = undefined;
});
afterEach(async () => {
  // Settle any request a test left in flight; the pending map is module state.
  await act(async () => {
    for (const id of ['pm1', 'pm2', 'pm9']) resolveMeetingToken({ pane_id: id, error: 'test reset' });
  });
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  act(() => {
    useStore.setState({ ws: null, snapshot: null });
  });
  vi.useRealTimers();
});

describe('PaneBox', () => {
  it('renders pane_type "meeting" as a meeting pane, never its stale output or an input box', () => {
    webPaneApi();
    render(<PaneBox pane={meetingPane(webMeta)} isActive inputMode="shell" pipelineActive={false} />);
    expect(screen.getByLabelText('Meeting')).toBeInTheDocument();
    expect(screen.getByText('MEETING')).toBeInTheDocument();
    expect(screen.queryByText(/stale text/)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/##meeting add agent m-3f9a2c/)).toBeInTheDocument();
  });

  it('dispatches on pane_type even when the input mode says web', () => {
    const api = webPaneApi();
    render(<PaneBox pane={meetingPane(webMeta)} isActive inputMode="web" pipelineActive={false} />);
    expect(api.create).toHaveBeenCalledWith('pm1', webMeta['meeting.url'], 'work', undefined, { meeting: true });
  });
});

describe('web meeting pane', () => {
  it('opens the meeting URL in the web-pane engine on persist:<meeting.profile>, as a meeting view', () => {
    const api = webPaneApi();
    render(<MeetingPaneView paneId="pm1" meta={webMeta} />);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith('pm1', 'https://meet.google.com/abc-defg-hij', 'work', undefined, {
      meeting: true,
    });
    // back / reload stay; no URL bar and no Ask Rysh panel
    expect(screen.getByTitle('Back')).toBeInTheDocument();
    expect(screen.getByTitle('Reload')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Enter URL...')).toBeNull();
    expect(screen.queryByText('Ask Rysh')).toBeNull();
  });

  it('defaults to the web-mode profile so a Google login carries over', () => {
    const api = webPaneApi();
    const meta: Record<string, string> = { ...webMeta };
    delete meta['meeting.profile'];
    render(<MeetingPaneView paneId="pm1" meta={meta} />);
    expect(api.create).toHaveBeenCalledWith('pm1', webMeta['meeting.url'], 'default', undefined, { meeting: true });
  });

  it('refuses a non-https or credential-bearing meeting link', () => {
    const api = webPaneApi();
    render(<MeetingPaneView paneId="pm1" meta={{ ...webMeta, 'meeting.url': 'http://meet.google.com/x' }} />);
    render(<MeetingPaneView paneId="pm2" meta={{ ...webMeta, 'meeting.url': 'https://u:p@meet.google.com/x' }} />);
    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getAllByText(/no valid meeting link/)).toHaveLength(2);
  });

  it('in a plain browser, points to the desktop app instead of a server-side browser', () => {
    render(<MeetingPaneView paneId="pm1" meta={webMeta} />);
    expect(screen.getByText(/desktop app to join/)).toBeInTheDocument();
    expect(sent.find((s) => s.action === 'webpane_open')).toBeUndefined();
  });
});

describe('a failed load in a meeting pane', () => {
  // 2026-09-29, E30 MacBook run: "Sign in" in a meeting pane hit
  // ERR_CONNECTION_CLOSED on accounts.google.com and left a white pane.
  const SIGN_IN = 'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fmeet.google.com%2Fabc';
  function status(extra: Record<string, unknown>) {
    act(() => {
      useStore.setState({
        webPaneStatuses: {
          pm1: { paneId: 'pm1', url: '', title: '', canGoBack: true, canGoForward: false, loading: false, ...extra },
        },
      });
    });
  }
  afterEach(() => {
    act(() => {
      useStore.setState({ webPaneStatuses: {} });
    });
  });

  it('says which page failed and why, and Retry loads it again', () => {
    const api = webPaneApi();
    render(<MeetingPaneView paneId="pm1" meta={webMeta} />);
    status({ loadError: { code: -100, description: 'ERR_CONNECTION_CLOSED', url: SIGN_IN } });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load accounts.google.com: ERR_CONNECTION_CLOSED");
    fireEvent.click(screen.getByText('Retry'));
    expect(api.navigate).toHaveBeenCalledWith('pm1', SIGN_IN);
  });

  it('shows nothing while the page loads or when it loaded', () => {
    webPaneApi();
    render(<MeetingPaneView paneId="pm1" meta={webMeta} />);
    status({ loading: true, loadError: { code: -100, description: 'ERR_CONNECTION_CLOSED', url: SIGN_IN } });
    expect(screen.queryByRole('alert')).toBeNull();
    status({});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
  });
});

describe('header', () => {
  it('shows id, platform, agents and bot phase', () => {
    webPaneApi();
    render(<MeetingPaneView paneId="pm1" meta={webMeta} />);
    expect(screen.getByText('m-3f9a2c')).toBeInTheDocument();
    expect(screen.getByText('meet')).toBeInTheDocument();
    expect(screen.getByText('agents: ada, bob')).toBeInTheDocument();
    expect(screen.getByTestId('meeting-bot').textContent).toBe('bot in call');
  });

  it('one chip per agent bot when there are several (design 043 D9)', () => {
    webPaneApi();
    render(
      <MeetingPaneView
        paneId="pm1"
        meta={{ ...webMeta, 'meeting.bot': 'joining', 'meeting.bots': 'ada:in_call,bob:joining' }}
      />,
    );
    const chips = screen.getAllByTestId('meeting-agent-bot').map((c) => c.textContent);
    expect(chips).toEqual(['ada: in call', 'bob: joining']);
    expect(screen.queryByTestId('meeting-bot')).toBeNull();
    expect(screen.queryByText('agents: ada, bob')).toBeNull();
  });

  it('one bot keeps the single badge', () => {
    webPaneApi();
    render(<MeetingPaneView paneId="pm1" meta={{ ...webMeta, 'meeting.agents': 'ada', 'meeting.bots': 'ada:in_call' }} />);
    expect(screen.getByText('agents: ada')).toBeInTheDocument();
    expect(screen.getByTestId('meeting-bot').textContent).toBe('bot in call');
  });

  it('shows the silent reporter and its newest report (design 045)', () => {
    webPaneApi();
    render(
      <MeetingPaneView
        paneId="pm1"
        meta={{ ...webMeta, 'meeting.reporter': 'left', 'meeting.report': '/r/meetings/m-3f9a2c/report.md' }}
      />,
    );
    const chip = screen.getByTestId('meeting-reporter');
    expect(chip.textContent).toBe('reporter: left');
    expect(chip.getAttribute('title')).toContain('/r/meetings/m-3f9a2c/report.md');
  });

  it('no reporter chip from a daemon that set none', () => {
    webPaneApi();
    render(<MeetingPaneView paneId="pm1" meta={webMeta} />);
    expect(screen.queryByTestId('meeting-reporter')).toBeNull();
  });

  it('no agents and no bot yet', () => {
    webPaneApi();
    render(<MeetingPaneView paneId="pm1" meta={{ ...webMeta, 'meeting.agents': '', 'meeting.bot': '' }} />);
    expect(screen.getByText('no agents')).toBeInTheDocument();
    expect(screen.queryByTestId('meeting-bot')).toBeNull();
  });

  it('Leave sends ##meeting leave <id> to the pane in rysh mode', () => {
    webPaneApi();
    render(<MeetingPaneView paneId="pm1" meta={webMeta} />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(sent).toContainEqual({
      action: 'submit_input',
      params: { text: '##meeting leave m-3f9a2c', mode: 'rysh', pane_id: 'pm1' },
    });
  });

  it('Leave is disabled for a malformed id, which would otherwise reach a ## line', () => {
    webPaneApi();
    render(<MeetingPaneView paneId="pm1" meta={{ ...webMeta, 'meeting.id': 'm-1 ; ##rysh stop' }} />);
    const leave = screen.getByRole('button', { name: 'Leave' });
    expect(leave).toBeDisabled();
    fireEvent.click(leave);
    expect(sent.find((s) => s.action === 'submit_input')).toBeUndefined();
  });
});

describe('livekit meeting pane', () => {
  it('asks the daemon for a token by pane id only, then renders MeetingRoom with it', async () => {
    openSocket();
    render(<MeetingPaneView paneId="pm1" meta={lkMeta} />);
    expect(screen.getByText(/Getting a join token/)).toBeInTheDocument();
    expect(sent).toEqual([{ action: 'meeting_token', params: { pane_id: 'pm1' } }]);
    await act(async () => {
      resolveMeetingToken({ pane_id: 'pm1', url: 'wss://lk.rysh.ai', token: JWT, identity: 'user:1', expires_at: 'x' });
    });
    await waitFor(() => expect(screen.getByTestId('room')).toBeInTheDocument());
    expect(lk.roomProps).toMatchObject({ serverUrl: 'wss://lk.rysh.ai', token: JWT, connect: true, audio: false });
  });

  it('never puts the token in the store or localStorage', async () => {
    openSocket();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<MeetingPaneView paneId="pm1" meta={lkMeta} />);
    await act(async () => {
      resolveMeetingToken({ pane_id: 'pm1', url: 'wss://lk.rysh.ai', token: JWT });
    });
    await waitFor(() => expect(screen.getByTestId('room')).toBeInTheDocument());
    const { ws: _ws, ...rest } = useStore.getState();
    expect(JSON.stringify(rest, (_k, v) => (typeof v === 'function' ? undefined : v))).not.toContain(JWT);
    for (const call of setItem.mock.calls) expect(String(call[1])).not.toContain(JWT);
  });

  it('shows the daemon error and asks again on Try again', async () => {
    openSocket();
    render(<MeetingPaneView paneId="pm1" meta={lkMeta} />);
    await act(async () => {
      resolveMeetingToken({ pane_id: 'pm1', error: 'pane pm1 is not a livekit meeting' });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('not a livekit meeting');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(sent.filter((s) => s.action === 'meeting_token')).toHaveLength(2);
  });

  it('refuses a grant that is not a LiveKit URL + JWT', async () => {
    openSocket();
    render(<MeetingPaneView paneId="pm1" meta={lkMeta} />);
    await act(async () => {
      resolveMeetingToken({ pane_id: 'pm1', url: 'ws://evil.example', token: JWT });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/wss/);
    expect(lk.roomProps).toBeUndefined();
  });

  it('says so when the daemon is not connected', async () => {
    render(<MeetingPaneView paneId="pm1" meta={lkMeta} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not connected');
    expect(sent).toEqual([]);
  });

  it('times out when the daemon never answers', async () => {
    vi.useFakeTimers();
    openSocket();
    render(<MeetingPaneView paneId="pm9" meta={lkMeta} />);
    await act(async () => {
      vi.advanceTimersByTime(16000);
    });
    vi.useRealTimers();
    expect(await screen.findByRole('alert')).toHaveTextContent('did not answer');
  });

  it('leaving the room locally offers a rejoin with a fresh token', async () => {
    openSocket();
    render(<MeetingPaneView paneId="pm1" meta={lkMeta} />);
    await act(async () => {
      resolveMeetingToken({ pane_id: 'pm1', url: 'wss://lk.rysh.ai', token: JWT });
    });
    await waitFor(() => expect(screen.getByTestId('room')).toBeInTheDocument());
    // The room's own disconnect (not the header Leave): local only.
    act(() => (lk.roomProps!.onDisconnected as () => void)());
    fireEvent.click(await screen.findByRole('button', { name: 'Rejoin' }));
    expect(sent.filter((s) => s.action === 'meeting_token')).toHaveLength(2);
    expect(sent.find((s) => s.action === 'submit_input')).toBeUndefined();
  });

  it('ignores replies for other panes', async () => {
    openSocket();
    render(<MeetingPaneView paneId="pm1" meta={lkMeta} />);
    await act(async () => {
      resolveMeetingToken({ pane_id: 'other', url: 'wss://lk.rysh.ai', token: JWT });
    });
    expect(screen.getByText(/Getting a join token/)).toBeInTheDocument();
    // settle pm1 so its pending request does not leak into the next test
    await act(async () => {
      resolveMeetingToken({ pane_id: 'pm1', error: 'done' });
    });
  });
});

describe('unknown kind', () => {
  it('renders a notice, not a broken pane', () => {
    render(<MeetingPaneView paneId="pm1" meta={{ 'meeting.id': 'm-000000', 'meeting.kind': 'hologram' }} />);
    expect(screen.getByText(/Unknown meeting kind/)).toBeInTheDocument();
  });
});

// E-81 (design 045): the reporter's report.md, which the daemon records in the
// pane's `meeting.report` meta, is one click away in the header.
describe('meeting pane header — Report link', () => {
  const REPORT = '/Users/ada/project/.rysh/meetings/m-3f9a2c/report.md';

  function withReportApi() {
    const api = webPaneApi();
    const openMeetingReport = vi.fn(async () => ({ success: true }));
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = { webPane: api, openMeetingReport };
    return openMeetingReport;
  }

  it('is hidden while no report exists', () => {
    withReportApi();
    render(<MeetingPaneView paneId="pm1" meta={webMeta} />);
    expect(screen.queryByRole('button', { name: /report/i })).toBeNull();
  });

  it('appears when the daemon records a report, without a reload, and opens only that report', () => {
    const open = withReportApi();
    const { rerender } = render(<MeetingPaneView paneId="pm1" meta={webMeta} />);
    expect(screen.queryByRole('button', { name: /report/i })).toBeNull();

    rerender(<MeetingPaneView paneId="pm1" meta={{ ...webMeta, 'meeting.report': REPORT }} />);
    const link = screen.getByRole('button', { name: /report/i });
    fireEvent.click(link);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('m-3f9a2c', REPORT);
    expect(sent).toEqual([]); // no `##` command, no daemon round trip
  });

  it('is hidden outside the desktop app (no way to open a local file there)', () => {
    render(<MeetingPaneView paneId="pm1" meta={{ ...lkMeta, 'meeting.report': REPORT }} />);
    expect(screen.queryByRole('button', { name: /report/i })).toBeNull();
  });
});
