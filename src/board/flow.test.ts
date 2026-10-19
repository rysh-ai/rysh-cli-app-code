import { describe, expect, it } from 'vitest';
import { buildFlow, flowSummary, FLOW_MAX_EVENTS, type FlowPane } from './flow';
import type { BoardPost, BoardThread } from '../types';
import input from './testdata/flow-input.json';
import expected from './testdata/flow-expected.json';

// Design 052. The golden fixture is shared with rysh-cli's Go model
// (internal/board/flow_test.go); both must produce flow-expected.json from
// flow-input.json, so the terminal and the desktop app draw the same graph.

describe('buildFlow — golden fixture (design 052 §5)', () => {
  it('reproduces flow-expected.json', () => {
    const got = buildFlow(input.board, input.threads as BoardThread[], input.panes as FlowPane[]);
    expect(JSON.parse(JSON.stringify(got))).toEqual(expected);
  });
});

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const post = (o: Partial<BoardPost>): BoardPost => ({ pane_id: A, persona: 'a', kind: 'milestone', text: 't', ts: 1, ...o });
const thread = (key: string, root: BoardPost | null, replies: BoardPost[] = []): BoardThread => ({
  key,
  root,
  replies,
  provisional: root === null,
});
const cmd = (id: string, ts: number, over: Partial<BoardPost> = {}) =>
  post({ kind: 'cmd', ts, cmd_id: id, to_pane_id: B, thread_id: `${A}/${id}`, ...over });

describe('buildFlow — edge cases', () => {
  it('only the RECIPIENT answers a prompt (board.Inbox)', () => {
    const c = cmd('m1', 10);
    const f = buildFlow('x', [thread(c.thread_id!, c, [post({ kind: 'ack', cmd_id: 'm1', thread_id: c.thread_id, ts: 20 })])], []);
    const e = f.edges.find((x) => x.type === 'prompt')!;
    expect(e.answered).toBe(0);
    expect(e.open).toBe(1);
  });

  it('an ack with no thread still answers its cmd', () => {
    const c = cmd('m1', 10);
    const ack = post({ pane_id: B, kind: 'ack', cmd_id: 'm1', ts: 30 });
    const f = buildFlow('x', [thread(c.thread_id!, c), thread('B/1', ack)], []);
    expect(f.edges.find((x) => x.type === 'prompt')!.answered).toBe(1);
    expect(f.edges.find((x) => x.type === 'prompt')!.latency_ms).toBe(20);
  });

  it('a retried send is one prompt', () => {
    const c = cmd('m1', 10);
    const f = buildFlow('x', [thread(c.thread_id!, c, [cmd('m1', 11)])], []);
    expect(f.stats.prompts).toBe(1);
  });

  it('median latency over an even count is the floored mean of the middle two', () => {
    const ts: BoardThread[] = [];
    [3, 4].forEach((lat, i) => {
      const c = cmd(`m${i}`, 100);
      ts.push(thread(c.thread_id!, c, [post({ pane_id: B, kind: 'reply', thread_id: c.thread_id, ts: 100 + lat })]));
    });
    expect(buildFlow('x', ts, []).edges.find((e) => e.type === 'prompt')!.latency_ms).toBe(3);
  });

  it('a provisional thread is status, not a half-resolved prompt', () => {
    const f = buildFlow('x', [thread('A/m9', null, [post({ pane_id: B, kind: 'ack', cmd_id: 'm9', thread_id: 'A/m9' })])], []);
    expect(f.events[0].type).toBe('status');
    expect(f.events[0].to).toBe('board:x');
  });

  it('normalises polling-stream to grid and omits empty meta', () => {
    const f = buildFlow('x', [], [
      { id: A, name: 'one', meta: { 'board.id': 'x', 'fleet.comm': 'polling-stream' } },
      { id: B, name: 'two', meta: { 'board.id': 'other' } },
    ]);
    expect(f.nodes).toEqual([
      { id: 'board:x', kind: 'board', label: 'x', posts: 0 },
      { id: A, kind: 'pane', label: 'one', comm: 'grid', posts: 0 },
    ]);
  });

  it('keeps the last 200 events but counts every status', () => {
    const roots = Array.from({ length: FLOW_MAX_EVENTS + 5 }, (_, i) => thread(`A/${i}`, post({ ts: i, thread_id: `A/${i}` })));
    const f = buildFlow('x', roots, []);
    expect(f.events).toHaveLength(FLOW_MAX_EVENTS);
    expect(f.events[0].ts).toBe(5);
    expect(f.stats.status).toBe(FLOW_MAX_EVENTS + 5);
  });

  it('summaries are the first non-empty line, clipped at 80 runes', () => {
    expect(flowSummary('\n\n  \x1b[1mhi\x1b[0m there \nnext')).toBe('hi there');
    expect(Array.from(flowSummary('é'.repeat(100)))).toHaveLength(80);
    expect(flowSummary('é'.repeat(100)).endsWith('…')).toBe(true);
  });

  it('labels pass through sanitiseInline; a blank persona falls back to the pane name', () => {
    const f = buildFlow('x', [thread('A/1', post({ persona: ' \x1b[1m ', thread_id: 'A/1' }))], [{ id: A, name: 'named' }]);
    expect(f.nodes[1].label).toBe('named');
  });

  it('a cmd with no address is status, not a prompt (the door refuses one)', () => {
    const f = buildFlow('x', [thread('A/1', post({ kind: 'cmd', cmd_id: 'm1', thread_id: 'A/1' }))], []);
    expect(f.events[0].type).toBe('status');
    expect(f.stats.prompts).toBe(0);
  });
});
