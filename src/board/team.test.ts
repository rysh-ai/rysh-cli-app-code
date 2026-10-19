import { describe, expect, it } from 'vitest';
import { buildFlow, type Flow, type FlowNode, type FlowPane } from './flow';
import { renderTeam, teamAge, teamCounts, teamGoalCell, teamRows } from './team';
import input from './testdata/flow-input.json';
import type { BoardThread } from '../types';

// The team view (design 054 §8b): the same cases, and the same rendered lines,
// as rysh-cli internal/board/team_test.go.

const node = (n: Partial<FlowNode> & Pick<FlowNode, 'id' | 'label'>): FlowNode => ({ kind: 'pane', posts: 0, ...n });

function teamFlow(): Flow {
  return {
    board: 'demo',
    nodes: [
      node({ id: 'w2', label: 'wkr-2', role: 'worker', parent: 'lead', work: 'blocked', activity: 'idle', health: 'ok', task: 'sdk', blocked_by: ['w1'] }),
      node({ id: 'lead', label: 'lead', role: 'portfolio-lead', work: 'blocked', activity: 'working', health: 'ok', task: 'summary', blocked_by: ['w2'] }),
      node({ id: 'w1', label: 'wkr-1', role: 'worker', parent: 'lead', work: 'progress', activity: 'working', health: 'ok', task: 'schema' }),
      node({ id: 'coord', label: 'coord' }), // relayed a message; not a member
      node({ id: 'fleet', kind: 'fleet', label: 'fleet' }),
    ],
    edges: [],
    events: [
      { ts: 100_000, type: 'status', from: 'w1', to: 'board:demo', kind: 'status', thread: 't1', summary: '' },
      { ts: 160_000, type: 'status', from: 'w1', to: 'board:demo', kind: 'status', thread: 't2', summary: '' },
      { ts: 10_000, type: 'status', from: 'lead', to: 'board:demo', kind: 'status', thread: 't3', summary: '' },
    ],
    stats: { panes: 4, prompts: 0, answered: 0, undelivered: 0, open: 0, status: 3 },
  };
}

describe('teamRows', () => {
  it('lists members only, in chain order, blockers by label', () => {
    const rows = teamRows(teamFlow());
    expect(rows.map((r) => r.label)).toEqual(['lead', 'wkr-2', 'wkr-1']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1]);
    expect(rows[1].blockedBy).toEqual(['wkr-1']);
    expect(rows[2].lastPost).toBe(160_000);
  });
});

describe('renderTeam', () => {
  it('draws the table and the tree', () => {
    const got = renderTeam(teamFlow(), 170_000).join('\n');
    for (const want of [
      'MEMBER    WORK      ACTIVITY  HEALTH       LAST POST  TASK / BLOCKING',
      'lead      blocked   working   ok           2m         ⧗ wkr-2 · summary',
      '└─ wkr-2  blocked   idle      ok           -          ⧗ wkr-1 · sdk',
      '└─ wkr-1  progress  working   ok           10s        schema',
      'health: 3 ok',
      'dependencies · 2 blocked · bottleneck: wkr-1 (2 waiting)',
      '  ▣ wkr-1 {progress·working}  ← 2 waiting',
      '    └─ wkr-2 {blocked·idle}  ← 1 waiting',
      '       └─ lead {blocked·working}',
    ]) {
      expect(got).toContain(want);
    }
    expect(got).not.toContain('coord');
  });

  it('always draws the tree: an empty one says so', () => {
    const f = teamFlow();
    f.nodes = f.nodes.map((n) => ({ ...n, blocked_by: undefined, work: n.work === 'blocked' ? 'done' : n.work }));
    const got = renderTeam(f, 170_000);
    expect(got[got.length - 1]).toBe('dependencies · none blocked');
    expect(teamCounts(f)).toEqual({ members: 3, blocked: 0 });
  });

  it('says when the board has no fleet', () => {
    const got = renderTeam({ ...teamFlow(), nodes: [node({ id: 'x', label: 'x' })] }, 0).join('\n');
    expect(got).toContain('no fleet members on this board');
  });

  it('says when no member has declared a status', () => {
    const got = renderTeam({ ...teamFlow(), nodes: [node({ id: 'a', label: 'a', role: 'worker' })] }, 0).join('\n');
    expect(got).toContain('no status declared yet');
  });

  // The design-052 golden fixture, through both renderers: these are the lines
  // rysh-cli's RenderTeam draws from it (BuildFlow, now = 9500). A model or
  // renderer change on either side that moves a member, a column or a blocker
  // fails here.
  it('draws the fixture exactly as the terminal does', () => {
    const f = buildFlow(input.board, input.threads as BoardThread[], input.panes as FlowPane[]);
    expect(renderTeam(f, 9500)).toEqual([
      'MEMBER       WORK      ACTIVITY  HEALTH       LAST POST  TASK / BLOCKING',
      'ceo          -         -         -            0s',
      '└─ mgr-a     progress  working   ok           1s         plan the parser',
      '   └─ wk-a1  blocked   idle      ok           0s         ⧗ mgr-a, human · parser',
      '   └─ wk-a2  -         -         -            -',
      '   └─ wk-a3  progress  idle      STALLED      0s         tests red',
      'health: 2 no status · 2 ok · 1 stalled',
      '',
      'dependencies · 1 blocked · bottleneck: mgr-a (1 waiting)',
      '  ▣ mgr-a {progress·working}  ← 1 waiting',
      '    └─ wk-a1 {blocked·idle}  · also blocked by human',
      '  ▣ human  ← 1 waiting',
      '    └─ wk-a1 {blocked·idle}  · also blocked by mgr-a',
    ]);
    expect(teamCounts(f)).toEqual({ members: 5, blocked: 1 });
  });
});

describe('teamAge', () => {
  it('renders seconds, minutes, hours, days; - for none', () => {
    expect(teamAge(0, 5000)).toBe('-');
    expect(teamAge(6000, 5000)).toBe('0s');
    expect(teamAge(1000, 13_000)).toBe('12s');
    expect(teamAge(1, 4 * 60_000 + 1)).toBe('4m');
    expect(teamAge(1, 3 * 3_600_000 + 1)).toBe('3h');
    expect(teamAge(1, 2 * 86_400_000 + 1)).toBe('2d');
  });
});

// The goal executor's verdict (design 055): the same flow and the same lines
// as rysh-cli team_test.go TestRenderTeamGoalColumnAndReport.
describe('renderTeam with a goal executor', () => {
  it('has no GOAL column and no report line without an executor', () => {
    const got = renderTeam(teamFlow(), 170_000).join('\n');
    expect(got).not.toContain('GOAL');
    expect(got).not.toContain('goal executor');
  });

  it('draws the GOAL column and the newest report, exactly as the terminal', () => {
    const f = teamFlow();
    f.nodes = f.nodes.map((n) =>
      n.id === 'w1'
        ? { ...n, goal_state: 'blocker', goal_pct: 40, goal_eta: 170_000 + 12 * 60_000 }
        : n.id === 'w2'
          ? { ...n, goal_state: 'stressed' }
          : n.id === 'lead'
            ? { ...n, goal_state: 'progressing', goal_eta: 110_000 }
            : n
    );
    f.events = [
      ...f.events,
      { ts: 165_000, type: 'status', from: 'fleet', to: 'board:demo', kind: 'goal-report', thread: 'r', summary: 'AT-RISK · 40% · bottleneck wkr-1 (2 waiting)' },
    ];
    const got = renderTeam(f, 170_000).join('\n');
    for (const want of [
      'goal executor · AT-RISK · 40% · bottleneck wkr-1 (2 waiting)',
      'MEMBER    WORK      ACTIVITY  HEALTH       GOAL                   LAST POST  TASK / BLOCKING',
      '└─ wkr-1  progress  working   ok           blocker 40% eta 12m    10s        schema',
      '└─ wkr-2  blocked   idle      ok           STRESSED               -          ⧗ wkr-1 · sdk',
      'lead      blocked   working   ok           progressing OVERDUE 1m 2m',
    ]) {
      expect(got).toContain(want);
    }
  });

  it('renders a goal cell', () => {
    expect(teamGoalCell({ goalState: 'strayed' }, 0)).toBe('STRAYED');
    expect(teamGoalCell({ goalState: undefined }, 0)).toBe('');
  });
});
