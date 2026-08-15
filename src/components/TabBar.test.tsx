import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { TabBar } from './TabBar';
import { Header } from './Header';
import { useStore } from '../store';
import type { TabSnapshot, WorkspaceSnapshot } from '../types';

// The tab bar has two orientations (rysh-cli 408a9a8: `##tab orientation`), and
// the orientation is the DAEMON's per-workspace state, not a local preference —
// it arrives on the snapshot as tab_bar_vertical and is changed by sending a
// command back. These tests pin the three things that can silently break that:
//
//   - the wire action name, which the Go switch in internal/web/server.go
//     matches exactly and drops when it does not,
//   - that both orientations render the SAME tab list off the same snapshot
//     (a column that lost the attention marker or the click target would look
//     fine and be useless),
//   - that exactly one bar renders — the header strip and the body column are
//     driven by the same flag with opposite polarity, so a mistake in either
//     place shows two tab bars or none.

function tab(id: string, title: string, attention = 0): TabSnapshot {
  return {
    id,
    title,
    active_pane_id: `${id}-pane`,
    lanes: [
      {
        id: `${id}-lane`,
        flex: 1,
        active_pane_id: `${id}-pane`,
        pane_groups: [
          {
            id: `${id}-group`,
            active_pane_id: `${id}-pane`,
            panes: [
              {
                id: `${id}-pane`,
                title: 'pane',
                flex: 1,
                mode: 'shell',
                output: '',
                status: '',
                last_command: '',
                provider_name: '',
                attention_count: attention,
              },
            ],
          },
        ],
      },
    ],
  };
}

const SNAPSHOT: WorkspaceSnapshot = {
  tabs: [tab('t1', 'build'), tab('t2', 'agents', 3)],
  active_tab_id: 't1',
  active_pane_id: 't1-pane',
};

/** Seed the store with a snapshot and a socket that records what is sent. */
function connect(snapshot: WorkspaceSnapshot) {
  const send = vi.fn();
  useStore.setState({
    snapshot,
    ws: { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
  });
  return send;
}

/** The single JSON command payload sent through the socket. */
function sentCommand(send: ReturnType<typeof vi.fn>, nth = 0) {
  return JSON.parse(send.mock.calls[nth][0] as string);
}

// The store is a module singleton, so each test has to hand it back empty.
// This hook runs BEFORE testing-library's cleanup (vitest stacks afterEach), so
// components are still mounted and re-render on the reset — hence act().
afterEach(() => {
  act(() => {
    useStore.setState({ snapshot: null, ws: null });
  });
});

describe('TabBar — both orientations render the same tabs', () => {
  it.each(['horizontal', 'vertical'] as const)('%s lists every tab', (orientation) => {
    connect(SNAPSHOT);
    render(<TabBar orientation={orientation} />);

    expect(screen.getByTestId('tab-bar')).toHaveAttribute('data-orientation', orientation);
    expect(screen.getByText('build')).toBeInTheDocument();
    expect(screen.getByText('agents')).toBeInTheDocument();
  });

  it.each(['horizontal', 'vertical'] as const)(
    '%s focuses the tab by its index when clicked',
    (orientation) => {
      const send = connect(SNAPSHOT);
      render(<TabBar orientation={orientation} />);

      fireEvent.click(screen.getByText('agents'));

      expect(sentCommand(send)).toEqual({
        type: 'command',
        data: { action: 'focus_tab_index', params: { index: 1 } },
      });
    }
  );

  it.each(['horizontal', 'vertical'] as const)(
    '%s shows the attention count of a tab whose panes are waiting',
    (orientation) => {
      connect(SNAPSHOT);
      render(<TabBar orientation={orientation} />);

      // 3 comes from the one pane in tab 2; tab 1 has none, so no marker.
      expect(screen.getByText('●3')).toBeInTheDocument();
      expect(screen.queryByText('●0')).not.toBeInTheDocument();
    }
  );

  it('numbers the rows in the column, matching ctrl+t <n>', () => {
    connect(SNAPSHOT);
    render(<TabBar orientation="vertical" />);

    const bar = screen.getByTestId('tab-bar');
    expect(within(bar).getByText('1')).toBeInTheDocument();
    expect(within(bar).getByText('2')).toBeInTheDocument();
  });

  it('falls back to a positional label for an untitled tab', () => {
    connect({ ...SNAPSHOT, tabs: [tab('t1', '')] });
    render(<TabBar orientation="vertical" />);

    expect(screen.getByText('tab-1')).toBeInTheDocument();
  });
});

describe('Header — the orientation toggle', () => {
  it('sends the set_tab_orientation action the daemon switches on', () => {
    const send = connect(SNAPSHOT);
    render(<Header />);

    fireEvent.click(screen.getByLabelText('Toggle tab bar orientation'));

    expect(sentCommand(send)).toEqual({
      type: 'command',
      data: { action: 'set_tab_orientation', params: { orientation: 'toggle' } },
    });
  });

  it('does not flip the bar locally — the daemon owns and persists it', () => {
    connect(SNAPSHOT);
    render(<Header />);

    fireEvent.click(screen.getByLabelText('Toggle tab bar orientation'));

    // Still horizontal: the header keeps its strip until a snapshot says
    // otherwise. Flipping optimistically would fight the next snapshot and, on
    // a daemon too old to know the command, leave the UI lying.
    expect(screen.getByTestId('tab-bar')).toHaveAttribute('data-orientation', 'horizontal');
  });
});

describe('Header — where the tab bar lives', () => {
  it('keeps the strip in the header while the orientation is horizontal', () => {
    connect(SNAPSHOT);
    render(<Header />);

    expect(screen.getByTestId('tab-bar')).toHaveAttribute('data-orientation', 'horizontal');
  });

  it('treats an absent tab_bar_vertical as horizontal (older daemon)', () => {
    connect({ ...SNAPSHOT, tab_bar_vertical: undefined });
    render(<Header />);

    expect(screen.getByTestId('tab-bar')).toHaveAttribute('data-orientation', 'horizontal');
  });

  it('drops the strip from the header once the bar goes vertical', () => {
    connect({ ...SNAPSHOT, tab_bar_vertical: true });
    render(<Header />);

    // App renders the column in the body instead; two bars would be a bug.
    expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
    // The toolbar comes with it, into the workspace row.
    expect(screen.getByLabelText('Toggle tab bar orientation')).toBeInTheDocument();
  });
});
