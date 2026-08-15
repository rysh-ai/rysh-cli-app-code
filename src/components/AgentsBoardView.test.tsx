import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { AgentsBoardView } from './AgentsBoardView';
import { useStore } from '../store';
import type { BoardData } from '../types';

// The client half of the agents board.
//
// An agents-board pane is SHELL-LESS: no PTY, no VT screen, no output buffer.
// Before this view, every non-TUI client fell through to rendering
// `pane.output`, which for such a pane holds whatever stale text was last
// written near it — observed live in the desktop app as an old
// `##pane list --meta` dump sitting in a board pane while four agents posted to
// that board and every post arrived.
//
// So the property under test is not "does it draw threads". It is that the view
// tells the truth about WHICH OF THREE WORLDS it is in — not asked yet, asked
// and unanswerable, answered-and-empty — because two of those three look
// identical the moment you let them.

const sent: Array<{ action: string; params: Record<string, unknown> }> = [];
vi.mock('../utils/commands', () => ({
  sendCommand: (action: string, params: Record<string, unknown>) => {
    sent.push({ action, params });
  },
}));

function seed(data: Partial<BoardData> & { paneId: string }) {
  act(() => {
    useStore.getState().setBoardData({
      board: 'desktop',
      fetchedAt: 1,
      ...data,
    } as BoardData);
  });
}

afterEach(() => {
  sent.length = 0;
  act(() => {
    useStore.setState({ boardData: {} });
  });
});

describe('AgentsBoardView', () => {
  it('asks for its own board as soon as it mounts', () => {
    render(<AgentsBoardView paneId="p1" boardId="desktop" />);
    const req = sent.find((s) => s.action === 'board_get');
    expect(req, 'a board pane that never asks shows nothing forever').toBeTruthy();
    expect(req!.params.pane_id).toBe('p1');
    // Forwarded VERBATIM: the server resolves it through msg.BoardIDFromMeta so
    // that this client and the terminal UI cannot disagree about which board a
    // pane is on. A client that "helpfully" defaulted it here would be the
    // second copy of that rule.
    expect(req!.params.board).toBe('desktop');
  });

  it('renders posts with their poster and kind', () => {
    render(<AgentsBoardView paneId="p1" boardId="desktop" />);
    seed({
      paneId: 'p1',
      threads: [
        {
          key: 'pane-a/1',
          root: {
            pane_id: 'pane-a',
            persona: 'one-tetra',
            kind: 'milestone',
            text: 'E12 closed and holding',
            ts: 1786731597570,
          },
          replies: [
            {
              pane_id: 'pane-b',
              persona: 'key-hornet',
              kind: 'reply',
              text: 'acknowledged',
              ts: 1786731597580,
              thread_id: 'pane-a/1',
            },
          ],
          provisional: false,
        },
      ],
      roster: [{ pane_id: 'pane-a', persona: 'one-tetra', ts: 1 }],
      stats: { threads: 1, provisional: 0, posts: 2, duplicates: 0, evicted: 0, unknown_version: 0 },
      roster_reconciled: true,
    });
    expect(screen.getByText('E12 closed and holding')).toBeTruthy();
    expect(screen.getByText('acknowledged')).toBeTruthy();
    expect(screen.getByText('one-tetra')).toBeTruthy();
    expect(screen.getByText('[milestone]')).toBeTruthy();
  });

  // THE test. A dead recorder and a quiet fleet are the same picture unless the
  // view refuses to make them one, which is why board.Ask returns ErrNoRecorder
  // instead of a zero reply and why the server forwards it rather than
  // flattening it to an empty list.
  it('says the recorder is not answering instead of showing an empty board', () => {
    render(<AgentsBoardView paneId="p1" boardId="desktop" />);
    seed({
      paneId: 'p1',
      error: 'board: the recorder did not answer (nats: no responders available for request)',
      no_recorder: true,
    });
    expect(screen.getByText(/recorder is not answering/i)).toBeTruthy();
    expect(
      screen.queryByText(/this board is empty/i),
      'an unreadable board must never be presented as an empty one'
    ).toBeNull();
  });

  it('distinguishes a refused request from a missing recorder', () => {
    render(<AgentsBoardView paneId="p1" boardId="desktop" />);
    seed({ paneId: 'p1', error: 'board: the recorder refused the query: unreadable query', no_recorder: false });
    expect(screen.getByText(/could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/recorder is not answering/i)).toBeNull();
  });

  it('says a board is empty only when the recorder actually answered', () => {
    render(<AgentsBoardView paneId="p1" boardId="desktop" />);
    seed({
      paneId: 'p1',
      threads: [],
      roster: [],
      stats: { threads: 0, provisional: 0, posts: 0, duplicates: 0, evicted: 0, unknown_version: 0 },
    });
    expect(screen.getByText(/this board is empty/i)).toBeTruthy();
    // And it names a command that exists — the lesson of rysh-cli 3ec4283,
    // where the hint an agent reads AFTER its post failed named a binary that
    // was not on the machine.
    expect(screen.getByText(/rysh board post/)).toBeTruthy();
  });

  it('shows nothing-yet rather than empty before the first answer arrives', () => {
    render(<AgentsBoardView paneId="p1" boardId="desktop" />);
    expect(screen.getByText(/reading the board/i)).toBeTruthy();
    expect(screen.queryByText(/this board is empty/i)).toBeNull();
  });

  // A window is truncated only if it SAYS it is truncated; otherwise a window
  // is silently presented as the whole board (design 025 §7.1a's discipline,
  // applied to the query's limit rather than to eviction).
  it('discloses threads the window left out', () => {
    render(<AgentsBoardView paneId="p1" boardId="desktop" />);
    seed({ paneId: 'p1', threads: [], roster: [], withheld: 12 });
    expect(screen.getByText(/\+12 older/)).toBeTruthy();
  });

  // F-26: registration is persistent, so a roster served as recorded can list
  // panes that have since closed. The reply says which kind it is and the view
  // must not launder that away.
  it('marks a roster that could not be checked against live panes', () => {
    render(<AgentsBoardView paneId="p1" boardId="desktop" />);
    seed({
      paneId: 'p1',
      threads: [],
      roster: [{ pane_id: 'pane-a', persona: 'one-tetra', ts: 1 }],
      roster_reconciled: false,
    });
    expect(screen.getByText(/1 agent\?/)).toBeTruthy();
  });
});

// A FOURTH state, and the one this client can fail on by itself: the daemon
// never answers at all. `board_get` is newer than daemons this renderer will
// meet, and an unknown ws action is silently ignored server-side — so an
// unbounded "reading the board…" would be the same silence-as-health defect,
// committed by the client this time.
describe('AgentsBoardView — a daemon that never answers', () => {
  it('stops claiming to be loading and says nothing was read', () => {
    vi.useFakeTimers();
    try {
      render(<AgentsBoardView paneId="p9" boardId="desktop" />);
      expect(screen.getByText(/reading the board/i)).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(11000);
      });
      expect(screen.getByText(/never answered/i)).toBeTruthy();
      expect(
        screen.queryByText(/this board is empty/i),
        'nothing was read, so nothing may be reported as empty'
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
