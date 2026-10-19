import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AgentsBoardView } from './AgentsBoardView';
import { useStore } from '../store';
import input from '../board/testdata/flow-input.json';
import type { FlowPane } from '../board/flow';
import type { BoardData, BoardThread, WorkspaceSnapshot } from '../types';

// Design 054 §8b in the desktop app: the board pane's team view (t) — the fleet
// status table and the dependency tree, from the golden fixture's fleet.

vi.mock('../utils/commands', () => ({ sendCommand: () => undefined }));

const threads = input.threads as BoardThread[];
const panes = input.panes as FlowPane[];
const [C, M, A1, A2, A3] = panes.map((p) => p.id);

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

function mount(ps: FlowPane[] = panes, paneId = 'bp') {
  render(<AgentsBoardView paneId={paneId} boardId="fleet-x" />);
  act(() => {
    useStore.setState({ snapshot: snapshotOf(ps) });
    useStore.getState().setBoardData({ paneId, board: 'fleet-x', threads, fetchedAt: 9500 } as BoardData);
  });
}

const openTeamByKey = () =>
  fireEvent.keyDown(screen.getByText('started the unit', { exact: false }).closest('[tabindex]')!, { key: 't' });

const members = () =>
  [...screen.getByTestId('board-team-table').querySelectorAll('tr[data-member]')].map((r) => r.getAttribute('data-member'));

afterEach(() => {
  act(() => {
    useStore.setState({ boardData: {}, snapshot: null });
  });
});

describe('board team view (design 054 §8b)', () => {
  it('t lists every fleet member in chain order with work, activity, health and blockers', () => {
    mount();
    openTeamByKey();
    expect(members()).toEqual([C, M, A1, A2, A3]);
    const row = (id: string) => screen.getByTestId('board-team-table').querySelector(`tr[data-member="${id}"]`)!;
    expect(row(A1).getAttribute('data-work')).toBe('blocked');
    expect(row(A1).querySelector('[data-blocked-by]')?.textContent).toContain('⧗ mgr-a, human');
    expect(row(A1).querySelector('[data-task]')?.textContent).toContain('parser');
    expect(row(A3).querySelector('[data-health]')?.textContent).toBe('STALLED');
    expect(row(M).textContent).toContain('plan the parser');
    expect(screen.getByTestId('board-team-health').textContent).toBe('health: 2 no status · 2 ok · 1 stalled');
  });

  it('draws the dependency tree under the table, bottleneck first', () => {
    mount();
    fireEvent.click(screen.getByText('team'));
    const deps = screen.getByTestId('board-team-deps');
    expect(deps.textContent).toContain('dependencies · 1 blocked · bottleneck: mgr-a (1 waiting)');
    expect(deps.querySelectorAll('[data-dep-root]')).toHaveLength(2); // mgr-a, human
  });

  it('always draws the tree: with nobody blocked it says so', () => {
    const unblocked = panes.map((p) => ({
      ...p,
      meta: Object.fromEntries(Object.entries(p.meta || {}).filter(([k]) => k !== 'fleet.blocked_by')),
    }));
    mount(unblocked, 'bp2');
    fireEvent.click(screen.getByText('team'));
    expect(screen.getByTestId('board-team-deps').textContent).toBe('dependencies · none blocked');
  });

  it('clicking a member highlights it in the table and the tree', () => {
    mount();
    fireEvent.click(screen.getByText('team'));
    const table = screen.getByTestId('board-team-table');
    fireEvent.click(table.querySelector(`tr[data-member="${M}"] button`)!);
    expect(table.querySelector(`tr[data-member="${M}"]`)!.className).toContain('bg-[#2a2a3a]');
    expect(screen.getByTestId('board-team-deps').querySelector(`[data-dep="${M}"] button`)!.className).toContain('text-white');
  });

  it('says so when the board has no fleet', () => {
    const plain = panes.map((p) => ({ ...p, meta: { 'board.id': 'fleet-x' } }));
    mount(plain, 'bp3');
    fireEvent.click(screen.getByText('team'));
    expect(screen.getByTestId('board-team').textContent).toContain('no fleet members on this board');
  });
});

describe('board team view with a goal executor (design 055)', () => {
  it('shows the GOAL column and the executor\'s newest report only when one runs', () => {
    mount();
    fireEvent.click(screen.getByText('team'));
    expect(screen.queryByTestId('board-team-goal-report')).toBeNull();
    expect(screen.getByTestId('board-team-table').textContent).not.toMatch(/goal/i);
  });

  it('draws stressed / blocker verdicts and the report line', () => {
    const withGoals = panes.map((p) =>
      p.id === M ? { ...p, meta: { ...p.meta, 'fleet.goal_state': 'blocker', 'fleet.goal_pct': '40' } }
        : p.id === A3 ? { ...p, meta: { ...p.meta, 'fleet.goal_state': 'stressed' } } : p
    );
    const report = {
      key: 'fleet/goal',
      root: { v: 1, pane_id: 'fleet', persona: 'fleet', kind: 'goal-report', text: 'AT-RISK · 40% · bottleneck mgr-a (1 waiting)\ngoal: x', ts: 9000 },
      replies: [],
    } as unknown as BoardThread;
    render(<AgentsBoardView paneId="bp9" boardId="fleet-x" />);
    act(() => {
      useStore.setState({ snapshot: snapshotOf(withGoals) });
      useStore.getState().setBoardData({ paneId: 'bp9', board: 'fleet-x', threads: [...threads, report], fetchedAt: 9500 } as BoardData);
    });
    fireEvent.click(screen.getByText('team'));
    expect(screen.getByTestId('board-team-goal-report').textContent).toContain('AT-RISK · 40% · bottleneck mgr-a (1 waiting)');
    const table = screen.getByTestId('board-team-table');
    expect(table.querySelector(`tr[data-member="${M}"] [data-goal="blocker"]`)?.textContent).toBe('blocker 40%');
    expect(table.querySelector(`tr[data-member="${A3}"] [data-goal="stressed"]`)?.textContent).toBe('STRESSED');
  });
});
