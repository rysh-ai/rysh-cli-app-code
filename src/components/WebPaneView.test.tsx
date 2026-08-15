import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WebPaneView } from './WebPaneView';
import { useStore } from '../store';
import type { WebEnv } from '../types';

// E-16: the browser-mode web pane is a JPEG of a page running in a server-side
// Chromium, and until now it was a picture — no pointer, no keyboard. These
// tests pin the client half of `webpane_input` against what the Go server
// actually accepts (rysh-cli internal/web/webpane_input.go):
//
//   - the payload shape {pane_id,kind,x,y,display_width,display_height,button,
//     key,modifiers,delta_x,delta_y} — a renamed field is a silent no-op,
//   - and the ONE rule that makes the coordinates mean anything: x/y are
//     relative to the rendered <img>, and display_width/display_height are that
//     image's MEASURED size (getBoundingClientRect), never the frame's source
//     size and never a CSS max-width. The server maps display → source per
//     axis; a client that sends the source size, or pre-scales the point
//     itself, double-maps every click.

const PANE = 'p1';

const ENV: WebEnv = {
  isWeb: true,
  platform: 'darwin',
  sessionName: 's',
  control: false,
  workspace: { path: '/w', name: 'w' },
  capabilities: {
    completion: true,
    workspaces: true,
    voice: false,
    webPane: true,
    restartDaemon: false,
    nativeOpen: false,
  },
};

/** Seed the store with a live server web pane and a socket that records sends. */
function connect() {
  const send = vi.fn();
  act(() => {
    useStore.setState({
      connected: true,
      webEnv: ENV,
      ws: { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
      webBindings: { [PANE]: { profile: 'default', url: 'https://example.com' } },
      webPaneFrames: {
        [PANE]: {
          paneId: PANE,
          url: 'https://example.com',
          title: 'Example',
          screenshot: 'AAAA',
          // The frame's own 1280x900 viewport. Deliberately NOT what the client
          // reports as display_width/height: the server maps display → source
          // itself, and a client that sent these would be mapped twice.
          sourceWidth: 1280,
          sourceHeight: 900,
        },
      },
      webPaneErrors: {},
    });
  });
  return send;
}

/** Every webpane_input params object sent through the socket, in order. */
function inputs(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls
    .map((c) => JSON.parse(c[0] as string))
    .filter((m) => m.type === 'command' && m.data.action === 'webpane_input')
    .map((m) => m.data.params);
}

/**
 * Render the pane and hand back its frame image, measured at 640x450 and offset
 * to (100,50) on screen — jsdom gives every element a zero rect, so the size the
 * component is supposed to read has to be supplied explicitly.
 */
function renderPane(rect = { left: 100, top: 50, width: 640, height: 450 }) {
  render(<WebPaneView paneId={PANE} />);
  const img = screen.getByRole('img');
  img.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  return img;
}

afterEach(() => {
  act(() => {
    useStore.setState({
      connected: false,
      ws: null,
      webEnv: null,
      webPaneFrames: {},
      webPaneErrors: {},
      webBindings: {},
    });
  });
});

describe('ServerWebPaneView — pointer input', () => {
  it('sends a click in image coordinates with the image’s measured size', () => {
    const send = connect();
    const img = renderPane();

    // Page coords (420,275) on an image whose top-left is (100,50) is (320,225)
    // in image space — the server's canonical case: a 1280x900 page shown at
    // 640x450 maps that to source (640,450).
    fireEvent.click(img, { clientX: 420, clientY: 275, button: 0 });

    expect(inputs(send)).toEqual([
      {
        pane_id: PANE,
        kind: 'click',
        x: 320,
        y: 225,
        display_width: 640,
        display_height: 450,
        button: 'left',
        modifiers: [],
      },
    ]);
  });

  it('reports the size it actually rendered, not the frame’s source size', () => {
    const send = connect();
    const img = renderPane({ left: 0, top: 0, width: 300, height: 200 });

    fireEvent.click(img, { clientX: 150, clientY: 100 });

    const [p] = inputs(send);
    expect([p.display_width, p.display_height]).toEqual([300, 200]);
    // The client never scales: it reports the point it was clicked at, in the
    // space it drew. Pre-scaling here would be mapped a second time server-side.
    expect([p.x, p.y]).toEqual([150, 100]);
  });

  it('names the button so a right-click is not silently a left-click', () => {
    const send = connect();
    const img = renderPane();

    fireEvent.contextMenu(img, { clientX: 100, clientY: 50, button: 2 });

    expect(inputs(send)[0]).toMatchObject({ kind: 'click', button: 'right' });
  });

  it('forwards a wheel event as a scroll carrying both deltas', () => {
    const send = connect();
    const img = renderPane();

    fireEvent.wheel(img, { clientX: 420, clientY: 275, deltaX: -12, deltaY: 120 });

    expect(inputs(send)[0]).toEqual({
      pane_id: PANE,
      kind: 'scroll',
      x: 320,
      y: 225,
      display_width: 640,
      display_height: 450,
      delta_x: -12,
      delta_y: 120,
    });
  });

  it('forwards pointer moves, throttled so one drag does not flood the socket', () => {
    vi.useFakeTimers();
    try {
      const send = connect();
      const img = renderPane();

      for (let i = 0; i < 20; i++) {
        fireEvent.mouseMove(img, { clientX: 100 + i, clientY: 50 + i });
      }

      const moves = inputs(send).filter((p) => p.kind === 'move');
      expect(moves.length).toBe(1);
      expect(moves[0]).toMatchObject({ kind: 'move', x: 0, y: 0 });

      // The throttle window is a delay, not a drop: the next move goes.
      act(() => {
        vi.advanceTimersByTime(200);
      });
      fireEvent.mouseMove(img, { clientX: 200, clientY: 150 });
      expect(inputs(send).filter((p) => p.kind === 'move').length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ServerWebPaneView — keyboard input', () => {
  it('takes focus on click so the next keystroke has somewhere to land', () => {
    connect();
    const img = renderPane();

    fireEvent.click(img, { clientX: 420, clientY: 275 });

    expect(document.activeElement).toBe(img);
  });

  it('sends a keystroke with its modifiers named the way press_key parses them', () => {
    const send = connect();
    const img = renderPane();

    fireEvent.keyDown(img, { key: 'a' });
    fireEvent.keyDown(img, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(img, { key: 'z', metaKey: true, altKey: true });

    expect(inputs(send)).toEqual([
      { pane_id: PANE, kind: 'key', key: 'a', modifiers: [] },
      { pane_id: PANE, kind: 'key', key: 'Enter', modifiers: ['shift'] },
      { pane_id: PANE, kind: 'key', key: 'z', modifiers: ['alt', 'meta'] },
    ]);
  });

  it('does not forward a bare modifier press as a keystroke', () => {
    const send = connect();
    const img = renderPane();

    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) fireEvent.keyDown(img, { key });

    expect(inputs(send)).toEqual([]);
  });

  it('leaves the multiplexer chords to the multiplexer', () => {
    const send = connect();
    const seen: string[] = [];
    const onGlobalKey = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener('keydown', onGlobalKey);
    try {
      const img = renderPane();
      fireEvent.keyDown(img, { key: 'l', ctrlKey: true });
      fireEvent.keyDown(img, { key: 'p', altKey: true });

      // Swallowing these would trap the keyboard in the pane with no way to
      // reach prefix mode, switch panes, or leave.
      expect(inputs(send)).toEqual([]);
      expect(seen).toEqual(['l', 'p']);
    } finally {
      document.removeEventListener('keydown', onGlobalKey);
    }
  });

  it('keeps its keys away from the multiplexer’s global bindings', () => {
    const send = connect();
    const onGlobalKey = vi.fn();
    document.addEventListener('keydown', onGlobalKey);
    try {
      const img = renderPane();
      fireEvent.keyDown(img, { key: 'a' });

      expect(inputs(send).length).toBe(1);
      // A keystroke meant for the page must not also drive the pane grid: the
      // URL bar stops propagation for the same reason.
      expect(onGlobalKey).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onGlobalKey);
    }
  });
});
