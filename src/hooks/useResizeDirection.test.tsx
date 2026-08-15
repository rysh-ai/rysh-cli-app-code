import { afterEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { useKeyboard } from './useKeyboard';
import { useStore } from '../store';
import type { WorkspaceSnapshot } from '../types';

// `delta` on resize_pane_width / resize_pane_height is a SCREEN DIRECTION, not a
// magnitude: +1 points toward the higher index (right / down). The daemon reads
// it to decide whether the focused lane/group grows or shrinks
// (rysh-cli internal/actors/tab_layout.go and lane.go), so the app and the TUI
// have to agree on the sign or the same key moves the layout opposite ways on
// the two surfaces.
//
// The height pair was swapped here — ↑ sent +1 and ↓ sent -1 — in BOTH the
// layout-mode arrows and pane-resize mode, while the width pair was correct. It
// is invisible in a screenshot and invisible in jsdom unless something pins the
// wire value, which is what this does.

const SNAPSHOT: WorkspaceSnapshot = {
  tabs: [
    {
      id: 't1',
      title: 'build',
      active_pane_id: 'p1',
      lanes: [
        {
          id: 'l1',
          flex: 1,
          active_pane_id: 'p1',
          pane_groups: [
            {
              id: 'g1',
              active_pane_id: 'p1',
              panes: [
                {
                  id: 'p1',
                  title: 'pane',
                  flex: 1,
                  mode: 'shell',
                  output: '',
                  status: '',
                  last_command: '',
                  provider_name: '',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  active_tab_id: 't1',
  active_pane_id: 'p1',
};

function Keys() {
  useKeyboard();
  return null;
}

/** Seeds the store with a socket that records every command sent. */
function connect() {
  const sent: Array<{ action: string; params?: Record<string, unknown> }> = [];
  useStore.setState({
    snapshot: SNAPSHOT,
    mode: 'normal',
    ws: {
      readyState: WebSocket.OPEN,
      send: (raw: string) => sent.push(JSON.parse(raw).data),
    } as unknown as WebSocket,
  });
  return sent;
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

afterEach(() => {
  act(() => {
    useStore.setState({ snapshot: null, ws: null, mode: 'normal' });
  });
});

describe('resize deltas encode a screen direction (+1 = right / down)', () => {
  it.each([
    // enter layout mode with ctrl+l, then the arrow
    { mode: 'layout' as const, enter: () => press('l', { ctrlKey: true }) },
    // pane mode (ctrl+p) then r opens resize mode
    {
      mode: 'resize' as const,
      enter: () => {
        press('p', { ctrlKey: true });
        press('R');
      },
    },
  ])('$mode mode maps the arrows the way the TUI does', ({ mode, enter }) => {
    const sent = connect();
    render(<Keys />);

    enter();
    if (useStore.getState().mode !== mode) {
      // resize mode is reached differently across builds; drive it directly so
      // the assertion below is about the deltas, not about how you get there.
      act(() => useStore.getState().setMode(mode));
    }

    sent.length = 0;
    press('ArrowDown');
    press('ArrowUp');
    press('ArrowRight');
    press('ArrowLeft');

    const deltaFor = (action: string, nth: number) =>
      sent.filter((c) => c.action === action)[nth]?.params?.delta;

    // Down is toward the higher index: +1. Up: -1. This is the pair that was
    // inverted, and inverted in both modes.
    expect(deltaFor('resize_pane_height', 0)).toBe(1);
    expect(deltaFor('resize_pane_height', 1)).toBe(-1);

    // Width was already correct; pinned so a "fix" to the height pair cannot be
    // applied to this one by symmetry.
    const widthAction = mode === 'layout' ? 'resize_pane_width' : 'resize_pane';
    expect(deltaFor(widthAction, 0)).toBe(1);
    expect(deltaFor(widthAction, 1)).toBe(-1);
  });
});
