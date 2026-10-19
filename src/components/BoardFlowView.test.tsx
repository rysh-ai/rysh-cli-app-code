import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AgentsBoardView, snapshotPanes } from './AgentsBoardView';
import { edgeLabel, layoutFlow } from './BoardFlowView';
import { buildFlow, type FlowPane } from '../board/flow';
import { useStore } from '../store';
import input from '../board/testdata/flow-input.json';
import type { BoardData, BoardThread, WorkspaceSnapshot } from '../types';

// Design 052 in the desktop app: the board pane's flow view draws the golden
// fixture's fleet — the same graph the terminal's `f` view draws from it.

vi.mock('../utils/commands', () => ({ sendCommand: () => undefined }));

const threads = input.threads as BoardThread[];
const panes = input.panes as FlowPane[];
const C = panes[0].id;
const M = panes[1].id;

function snapshotOf(ps: FlowPane[]): WorkspaceSnapshot {
  return {
    active_tab_id: 't',
    active_pane_id: ps[0].id,
    tabs: [
      {
        id: 't',
        lanes: [{ id: 'l', pane_groups: [{ id: 'g', panes: ps.map((p) => ({ id: p.id, title: p.name, meta: p.meta })) }] }],
      },
    ],
  } as unknown as WorkspaceSnapshot;
}

function mount() {
  render(<AgentsBoardView paneId="bp" boardId="fleet-x" />);
  act(() => {
    useStore.setState({ snapshot: snapshotOf(panes) });
    useStore.getState().setBoardData({ paneId: 'bp', board: 'fleet-x', threads, fetchedAt: 9500 } as BoardData);
  });
}

afterEach(() => {
  act(() => {
    useStore.setState({ boardData: {}, snapshot: null });
  });
});

describe('board views in the desktop app (design 051)', () => {
  it('opens on status, like the terminal, and counts both views', () => {
    mount();
    expect(screen.getByText('started the unit', { exact: false })).toBeTruthy();
    expect(screen.queryByText('write the lexer')).toBeNull();
    expect(screen.getByText('3 status')).toBeTruthy();
    expect(screen.getByText('6 prompt')).toBeTruthy();
  });

  it('p shows the prompt threads', () => {
    mount();
    fireEvent.keyDown(screen.getByText('started the unit', { exact: false }).closest('[tabindex]')!, { key: 'p' });
    expect(screen.getByText('write the lexer')).toBeTruthy();
    expect(screen.queryByText('started the unit', { exact: false })).toBeNull();
  });
});

describe('board flow view (design 052)', () => {
  it('f draws every node, the prompt edges with their state, and the sequence', () => {
    mount();
    fireEvent.click(screen.getByText('flow'));
    const flow = screen.getByTestId('board-flow');
    // Five panes, the board, the listener and the fleet actor (design 054).
    expect(flow.querySelectorAll('[data-node]')).toHaveLength(8);
    expect(flow.querySelector(`[data-edge="prompt:${M}:${panes[2].id}"]`)).toBeTruthy();
    expect(screen.getByText('2 prompts · 1 ✓ · 1 ✗ · ack 1.0s')).toBeTruthy();
    expect(screen.getByTestId('board-flow-sequence').querySelectorAll('[data-event]')).toHaveLength(14);
  });

  it('draws the fleet status ledger: badges, activity, blocks edges, the check-in (design 054)', () => {
    mount();
    fireEvent.click(screen.getByText('flow'));
    const flow = screen.getByTestId('board-flow');
    // wk-a1 is blocked by mgr-a: a blocks edge, and the header counts it.
    expect(flow.querySelector(`[data-edge="blocks:${panes[2].id}:${M}"]`)).toBeTruthy();
    expect(screen.getByText('1 blocked')).toBeTruthy();
    expect(screen.getByText('blocked·idle')).toBeTruthy();
    expect(screen.getByText('progress·working')).toBeTruthy();
    expect(screen.getByText('progress·STALLED')).toBeTruthy();
    expect(flow.querySelector(`[data-node="${M}"] [data-activity="working"]`)).toBeTruthy();
    // The fleet actor's check-in to wk-a3, answered by its status reply.
    expect(flow.querySelector(`[data-edge="prompt:fleet:${panes[4].id}"]`)).toBeTruthy();
    expect(screen.getByText('fleet actor')).toBeTruthy();
  });

  it('shows the dependency tree and tags the bottleneck in the graph (design 054 §8a)', () => {
    mount();
    fireEvent.click(screen.getByText('flow'));
    const deps = screen.getByTestId('board-flow-deps');
    expect(deps.textContent).toContain('dependencies · 1 blocked · bottleneck: mgr-a (1 waiting)');
    expect(deps.querySelectorAll('[data-dep-root]')).toHaveLength(2); // mgr-a, human
    expect(deps.querySelector(`[data-dep="${panes[2].id}"]`)?.textContent).toContain('also blocked by human');
    const tag = screen.getByTestId('board-flow').querySelector(`[data-node="${M}"] [data-bottleneck]`);
    expect(tag?.textContent).toContain('BOTTLENECK · 1 waiting');
    // Clicking an agent in the tree focuses it: the sequence narrows to it.
    const all = screen.getByTestId('board-flow-sequence').querySelectorAll('[data-event]').length;
    fireEvent.click(deps.querySelector(`[data-dep="${M}"] button`)!);
    expect(screen.getByText(/showing mgr-a · clear/)).toBeTruthy();
    expect(screen.getByTestId('board-flow-sequence').querySelectorAll('[data-event]').length).toBeLessThan(all);
  });

  it('has no dependency panel when nobody is blocked', () => {
    const unblocked = panes.map((p) => ({ ...p, meta: Object.fromEntries(Object.entries(p.meta || {}).filter(([k]) => k !== 'fleet.blocked_by' && k !== 'fleet.work')) }));
    render(<AgentsBoardView paneId="bp2" boardId="fleet-x" />);
    act(() => {
      useStore.setState({ snapshot: snapshotOf(unblocked) });
      useStore.getState().setBoardData({ paneId: 'bp2', board: 'fleet-x', threads, fetchedAt: 9500 } as BoardData);
    });
    fireEvent.click(screen.getByText('flow'));
    expect(screen.queryByTestId('board-flow-deps')).toBeNull();
  });

  it('clicking a node narrows the sequence to its traffic', () => {
    mount();
    fireEvent.click(screen.getByText('flow'));
    fireEvent.click(screen.getByTestId('board-flow').querySelector(`[data-node="${C}"]`)!);
    // ceo: its two prompts, the retried send and the ack it got back.
    expect(screen.getByTestId('board-flow-sequence').querySelectorAll('[data-event]')).toHaveLength(4);
  });

  it('a recent edge pulses; an old one does not', () => {
    mount();
    fireEvent.click(screen.getByText('flow'));
    const live = (id: string) =>
      screen.getByTestId('board-flow').querySelector(`[data-edge="${id}"] path`)!.getAttribute('class');
    expect(live(`prompt:${C}:${panes[3].id}`)).toBe('rysh-flow-live'); // last_ts 10000, now 9500
    expect(live(`chain:${C}:${M}`)).toBeNull();
  });
});

describe('layout', () => {
  it('layers panes by chain depth and puts relays below them', () => {
    const { nodes } = layoutFlow(buildFlow('fleet-x', threads, panes));
    const y = (id: string) => nodes.find((n) => n.id === id)!.y;
    expect(y(C)).toBeLessThan(y(M));
    expect(y(M)).toBeLessThan(y(panes[2].id));
    expect(y('listener')).toBeGreaterThan(y(panes[2].id));
  });

  it('never overlaps nodes: a wide layer wraps onto extra rows', () => {
    const lead: FlowPane = { id: 'lead', name: 'lead', meta: { 'board.id': 'b' } };
    const many: FlowPane[] = Array.from({ length: 9 }, (_, i) => ({
      id: `w${i}`,
      name: `worker-${i}`,
      meta: { 'board.id': 'b', 'fleet.parent': 'lead' },
    }));
    const { nodes } = layoutFlow(buildFlow('b', [], [lead, ...many]));
    const boxes = nodes.filter((n) => n.kind !== 'board');
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const apart = Math.abs(a.x - b.x) >= 128 || Math.abs(a.y - b.y) >= 34;
        expect(apart, `${a.id} (${a.x},${a.y}) overlaps ${b.id} (${b.x},${b.y})`).toBe(true);
      }
    }
    // Every worker is still below the lead, and the nine span more than one row.
    const leadY = nodes.find((n) => n.id === 'lead')!.y;
    const ys = new Set(many.map((m) => nodes.find((n) => n.id === m.id)!.y));
    expect([...ys].every((y) => y > leadY)).toBe(true);
    expect(ys.size).toBeGreaterThan(1);
    // Nothing is placed under the board's column.
    const board = nodes.find((n) => n.kind === 'board')!;
    expect(boxes.every((n) => n.x + 64 <= board.x - 64)).toBe(true);
  });

  it('keeps the golden fixture on its original rows (no layer is too wide)', () => {
    const { nodes } = layoutFlow(buildFlow('fleet-x', threads, panes));
    const y = (id: string) => nodes.find((n) => n.id === id)!.y;
    expect(y(panes[2].id)).toBe(y(panes[3].id));
    expect(y(panes[3].id)).toBe(y(panes[4].id));
  });

  it('survives a fleet.parent cycle', () => {
    const cyc: FlowPane[] = [
      { id: 'a', name: 'a', meta: { 'board.id': 'b', 'fleet.parent': 'c' } },
      { id: 'c', name: 'c', meta: { 'board.id': 'b', 'fleet.parent': 'a' } },
    ];
    expect(() => layoutFlow(buildFlow('b', [], cyc))).not.toThrow();
  });

  it('labels a prompt edge with counts and median ack time', () => {
    expect(edgeLabel({ type: 'prompt', from: 'a', to: 'b', count: 1, answered: 0, undelivered: 0, open: 1 })).toBe('1 prompt · 1 open');
  });
});

describe('snapshotPanes', () => {
  it('drops panes that cannot host an agent (domain.PaneCanHostAnAgent)', () => {
    const snap = snapshotOf(panes);
    const g = (snap.tabs[0].lanes[0].pane_groups[0].panes as unknown as Array<Record<string, unknown>>);
    g.push({ id: 'board-pane', title: 'board', pane_type: 'agents-board', meta: { 'board.id': 'fleet-x' } });
    g.push({ id: 'meet', title: 'm', pane_type: 'meeting', meta: {} });
    const ids = snapshotPanes(snap).map((p) => p.id);
    expect(ids).not.toContain('board-pane');
    expect(ids).not.toContain('meet');
    expect(ids).toContain(C);
  });
});
