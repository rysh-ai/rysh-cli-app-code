import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import MobileApp from '../MobileApp';
import { useStore } from '../store';
import type { PaneSnapshot, WorkspaceSnapshot } from '../types';

// E16 T3, client half of clipboard_copy.
//
// The server can now hand a pane's buffer to the asking client, and nothing
// called it. This is the direction that did not exist: a phone could always type
// INTO a pane (PaneBox forwards a paste to the PTY as raw_key_input) but had no
// way to get a stack trace or a generated key back OUT.
//
// The two things these tests hold down:
//
//  1. the request names the buffer the user is actually looking at — asking for
//     `output` while the screen shows the AI plane copies the wrong text and
//     looks like it worked;
//  2. a clipboard write that the browser refuses is SHOWN. Safari and every
//     browser in a non-secure context reject navigator.clipboard outside a user
//     gesture, and our text arrives one round trip after the tap. A silent
//     failure there is indistinguishable from success — the user walks away
//     believing they have the output, and pastes whatever was there before.

vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => undefined }));

beforeAll(() => {
  // The pane screen mounts the real PaneBox, whose usePaneResize observes the
  // content box; jsdom has no layout engine and therefore no ResizeObserver.
  // Same stub as useMaximizePane.test.tsx, for the same reason.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function pane(overrides: Partial<PaneSnapshot> = {}): PaneSnapshot {
  return {
    id: 'pane-1',
    title: 'claude',
    flex: 1,
    mode: 'shell',
    output: 'on screen',
    status: 'idle',
    last_command: '',
    provider_name: '',
    attention_count: 0,
    ...overrides,
  } as PaneSnapshot;
}

function snapshot(p: PaneSnapshot): WorkspaceSnapshot {
  return {
    tabs: [
      {
        id: 't1',
        title: 'build',
        active_pane_id: p.id,
        lanes: [{ id: 'l1', flex: 1, active_pane_id: p.id, pane_groups: [{ id: 'g1', active_pane_id: p.id, panes: [p] }] }],
      },
    ],
    active_tab_id: 't1',
    active_pane_id: p.id,
  };
}

function connect(p = pane(), inputModes: Record<string, string> = {}) {
  const send = vi.fn();
  act(() => {
    useStore.setState({
      snapshot: snapshot(p),
      connected: true,
      ws: { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
      paneInputModes: inputModes as never,
      clipboardResult: null,
    });
  });
  return send;
}

/** Drill the phone down to the pane screen, the way a finger does. */
function openPaneScreen() {
  render(<MobileApp />);
  fireEvent.click(screen.getByText('build'));
  fireEvent.click(screen.getByText('claude'));
}

function copyRequests(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls
    .map((c) => JSON.parse(c[0] as string))
    .filter((m) => m.type === 'command' && m.data.action === 'clipboard_copy')
    .map((m) => m.data.params);
}

/** Answer the outstanding request the way the server would. */
function serverReplies(fields: Partial<Record<string, unknown>>, requestId: string) {
  act(() => {
    useStore.getState().setClipboardResult({
      requestId,
      paneId: 'pane-1',
      source: 'output',
      text: 'on screen',
      truncated: false,
      err: '',
      ...fields,
    } as never);
  });
}

afterEach(() => {
  act(() => {
    useStore.setState({
      snapshot: null,
      connected: false,
      ws: null,
      paneInputModes: {},
      clipboardResult: null,
    });
  });
  // @ts-expect-error — restore whatever the test replaced
  delete navigator.clipboard;
});

describe('copying a pane out to the phone', () => {
  it('offers a copy affordance on the pane screen', () => {
    connect();
    openPaneScreen();

    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('asks for the buffer that is on screen, correlated by request id', () => {
    const send = connect();
    openPaneScreen();

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));

    const [req] = copyRequests(send);
    expect(req.pane_id).toBe('pane-1');
    expect(req.source).toBe('output');
    // No request_id, no reply — the server drops it silently, by design.
    expect(typeof req.request_id).toBe('string');
    expect(req.request_id.length).toBeGreaterThan(0);
  });

  it('asks for the AI plane when the pane is showing the AI plane', () => {
    const send = connect(pane(), { 'pane-1': 'prompt' });
    openPaneScreen();

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));

    expect(copyRequests(send)[0].source).toBe('ai_output');
  });

  it('asks for the VT screen of a pane running a live program', () => {
    const send = connect(pane({ raw_mode: true } as Partial<PaneSnapshot>), { 'pane-1': 'shell' });
    openPaneScreen();

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));

    expect(copyRequests(send)[0].source).toBe('vt_screen');
  });

  it('writes the reply to the device clipboard and says what it copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const send = connect();
    openPaneScreen();
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    serverReplies({ text: 'boom: stack trace' }, copyRequests(send)[0].request_id);

    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('boom: stack trace');
  });

  it('says the copy is a tail when the server truncated it', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    const send = connect();
    openPaneScreen();
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    serverReplies({ truncated: true }, copyRequests(send)[0].request_id);

    expect(await screen.findByText(/last .* of a longer buffer|truncated|tail/i)).toBeInTheDocument();
  });

  it('hands the text over for manual copying when the browser refuses', async () => {
    // jsdom has no navigator.clipboard at all — the same shape as an insecure
    // context or a browser that denies the permission.
    const send = connect();
    openPaneScreen();
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    serverReplies({ text: 'copy me by hand' }, copyRequests(send)[0].request_id);

    expect(await screen.findByText(/could not write.*clipboard|select and copy/i)).toBeInTheDocument();
    // The pane screen has its own composer, so ask for this textarea by name.
    const box = screen.getByLabelText('Pane output to copy') as HTMLTextAreaElement;
    expect(box.value).toBe('copy me by hand');
  });

  it('shows the server’s error instead of an empty success', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });

    const send = connect();
    openPaneScreen();
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    serverReplies({ text: '', err: 'pane did not answer: timeout' }, copyRequests(send)[0].request_id);

    expect(await screen.findByText(/pane did not answer/)).toBeInTheDocument();
    expect(screen.queryByText(/^copied/i)).not.toBeInTheDocument();
  });

  it('ignores a reply that answers somebody else’s request', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    connect();
    openPaneScreen();
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    serverReplies({ text: 'not yours' }, 'some-other-request');

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText(/copied/i)).not.toBeInTheDocument();
  });

  it('is honest that this is one direction only', () => {
    connect();
    openPaneScreen();

    // Copy reads a buffer; paste types into a PTY and needs an interactive
    // pane. Presenting them as a symmetric pair is the misreading the protocol
    // spec (§3.11) explicitly warns clients not to make.
    const btn = screen.getByRole('button', { name: /copy/i });
    expect(btn.title.toLowerCase()).toContain('this device');
    expect(btn.title.toLowerCase()).not.toContain('paste');
  });
});
