import { describe, expect, it } from 'vitest';
import { buildFlow, type Flow, type FlowNode, type FlowPane } from './flow';
import { bottleneck, buildFlowDeps, renderFlowDeps, renderFlowDepsFit } from './flowDeps';
import type { BoardThread } from '../types';
import input from './testdata/flow-input.json';

// Design 054 §8a. The expected lines are the ones rysh-cli's
// internal/board/flow_deps_test.go pins, so the terminal and the app name the
// same bottleneck in the same words.

const pane = (id: string, work: string, ...blockedBy: string[]): FlowNode => ({
  id,
  kind: 'pane',
  label: id,
  posts: 0,
  work,
  ...(blockedBy.length ? { blocked_by: blockedBy } : {}),
});
const flowOf = (...nodes: FlowNode[]): Flow => ({
  board: 'x',
  nodes,
  edges: [],
  events: [],
  stats: { panes: nodes.length, prompts: 0, answered: 0, undelivered: 0, open: 0, status: 0 },
});

// The live graph from design 054 §8a: a chain, a diamond, a human blocker, a ring.
const live = flowOf(
  pane('api', 'progress'),
  pane('ui', 'blocked', 'api'),
  pane('e2e', 'blocked', 'ui', 'api'),
  pane('rel', 'blocked', 'e2e', 'docs', 'cache'),
  pane('docs', 'blocked', 'human'),
  pane('cache', 'blocked', 'auth'),
  pane('auth', 'blocked', 'cache')
);

describe('buildFlowDeps', () => {
  it('is empty when nobody is blocked', () => {
    const d = buildFlowDeps(flowOf(pane('a', 'progress')));
    expect(d.blocked).toBe(0);
    expect(bottleneck(d)).toBeUndefined();
    expect(renderFlowDeps(d)).toEqual([]);
  });

  it('roots at the unblocked blockers, most-waited-on first', () => {
    const d = buildFlowDeps(
      flowOf(
        pane('mgr', 'progress'),
        pane('w1', 'blocked', 'mgr'),
        pane('w2', 'blocked', 'w1'),
        pane('w3', 'blocked', 'mgr', 'human'),
        pane('w4', 'progress'),
        pane('w5', 'blocked', 'w4')
      )
    );
    expect(d.roots.map((r) => [r.label, r.waiting])).toEqual([
      ['mgr', 3],
      ['w4', 1],
      ['human', 1],
    ]);
    expect(renderFlowDeps(d)).toEqual(
      expect.arrayContaining([
        'dependencies · 4 blocked · bottleneck: mgr (3 waiting)',
        '  ▣ mgr {progress}  ← 3 waiting',
        '    ├─ w1 {blocked}  ← 1 waiting',
        '    │  └─ w2 {blocked}',
        '    └─ w3 {blocked}  · also blocked by human',
        '  ▣ human  ← 1 waiting',
        '    └─ w3 {blocked}  · also blocked by mgr',
      ])
    );
  });

  it('draws a diamond once', () => {
    const d = buildFlowDeps(
      flowOf(pane('r', 'progress'), pane('a', 'blocked', 'r'), pane('b', 'blocked', 'r'), pane('c', 'blocked', 'a', 'b'), pane('e', 'blocked', 'c'))
    );
    expect(d.roots[0].waiting).toBe(4);
    const text = renderFlowDeps(d).join('\n');
    expect(text.split('e {blocked}').length - 1).toBe(1);
    expect(text).toContain('(see above)');
  });

  it('lists a deadlock with what it holds up', () => {
    const d = buildFlowDeps(flowOf(pane('a', 'blocked', 'b'), pane('b', 'blocked', 'a'), pane('c', 'blocked', 'a')));
    expect(d.roots).toEqual([]);
    expect(d.cycles.map((c) => [c.members, c.waiting])).toEqual([[['a', 'b'], 1]]);
    expect(renderFlowDeps(d)).toContain('  ⟳ DEADLOCK  a → b → a · 1 waiting on it');
  });

  it('fits: every root and deadlock survive before anything is cut', () => {
    expect(renderFlowDeps(buildFlowDeps(live)).length).toBeGreaterThan(5);
    expect(renderFlowDepsFit(buildFlowDeps(live), 5)).toEqual([
      'dependencies · 6 blocked · bottleneck: api (3 waiting) · 1 deadlock',
      '  ▣ api {progress}  ← 3 waiting  ⇐ ui, e2e',
      '  ▣ human  ← 2 waiting  ⇐ docs',
      '  ⟳ DEADLOCK  cache → auth → cache · 1 waiting on it',
    ]);
    const cut = renderFlowDepsFit(buildFlowDeps(live), 3);
    expect(cut).toHaveLength(3);
    expect(cut[2]).toContain('more');
  });

  it('reads the golden fixture the way the terminal does', () => {
    const f = buildFlow(input.board, input.threads as BoardThread[], input.panes as FlowPane[]);
    expect(renderFlowDeps(buildFlowDeps(f))).toEqual(
      expect.arrayContaining([
        'dependencies · 1 blocked · bottleneck: mgr-a (1 waiting)',
        '  ▣ mgr-a {progress·working}  ← 1 waiting',
        '    └─ wk-a1 {blocked·idle}  · also blocked by human',
        '  ▣ human  ← 1 waiting',
      ])
    );
  });
});
