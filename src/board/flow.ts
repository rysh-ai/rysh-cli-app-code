import type { BoardPost, BoardThread } from '../types';
import { boardPersona, sanitiseBody, sanitiseInline } from './items';

// The board flow model (design 052): who orders whom, what is open, what
// bounced, how long acks take — the board's traffic as a graph and a timeline.
//
// A PORT. rysh-cli internal/board/flow.go is the other implementation, and both
// are held to the same golden fixture (new_roadmap/designs/052-fixtures, copied
// to ./testdata). Change the design and the fixture first, then both.
//
// Pure: no store, no clock. The inputs are what the app already has — a
// board_get answer and the workspace snapshot's panes — so the view works
// against any daemon that answers board_get.

export interface FlowPane {
  id: string;
  name: string;
  meta?: Record<string, string>;
}

export type FlowNodeKind = 'board' | 'pane' | 'courier' | 'listener' | 'fleet';

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  role?: string;
  parent?: string;
  comm?: string;
  posts: number;
  // The fleet status ledger (design 054), mirrored onto pane meta by the
  // daemon's fleet actor: declared work, observed activity, derived health,
  // and who this agent is blocked by (pane ids, or "human" / "ext:<what>").
  work?: string;
  task?: string;
  activity?: string;
  health?: string;
  blocked_by?: string[];
  // The goal executor's verdict (design 055), mirrored onto pane meta by it:
  // the primary condition (progressing, blocker, stressed, strayed, …),
  // declared progress and ETA (unix ms). Omitted with no executor.
  goal_state?: string;
  goal_pct?: number;
  goal_eta?: number;
}

export type FlowEdgeType = 'chain' | 'blocks' | 'prompt' | 'undelivered' | 'status';

export interface FlowEdge {
  type: FlowEdgeType;
  from: string;
  to: string;
  count: number;
  answered?: number;
  undelivered?: number;
  open?: number;
  latency_ms?: number;
  last_ts?: number;
}

export type FlowEventType = 'prompt' | 'ack' | 'reply' | 'undelivered' | 'status';

export interface FlowEvent {
  ts: number;
  type: FlowEventType;
  from: string;
  to: string;
  kind: string;
  thread: string;
  cmd_id?: string;
  summary: string;
}

export interface FlowStats {
  panes: number;
  prompts: number;
  answered: number;
  undelivered: number;
  open: number;
  status: number;
  blocked?: number; // pane nodes that declare blocked (design 054)
}

export interface Flow {
  board: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  events: FlowEvent[];
  stats: FlowStats;
}

export const FLOW_MAX_EVENTS = 200;
const UNDELIVERED = 'undelivered';
// courier / listener relay prompts; fleet is the fleet actor (design 054),
// which posts check-ins and alerts as the board identity "fleet".
const RELAYS = new Set(['courier', 'listener', 'fleet']);
const EDGE_ORDER: FlowEdgeType[] = ['chain', 'blocks', 'prompt', 'undelivered', 'status'];

/** First non-empty line of the sanitised body, over 80 runes → 79 + "…". */
export function flowSummary(text: string): string {
  const line = sanitiseBody(text)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '') ?? '';
  const runes = Array.from(line);
  return runes.length > 80 ? runes.slice(0, 79).join('') + '…' : line;
}

function normaliseComm(c: string | undefined): string | undefined {
  const v = (c || '').trim();
  if (!v) return undefined;
  return v === 'polling-stream' ? 'grid' : v;
}

interface Prompt {
  cmd: BoardPost;
  answeredAt?: number; // earliest answering post's ts
  undelivered: boolean;
}

export function buildFlow(board: string, threads: BoardThread[] | null | undefined, panes: FlowPane[]): Flow {
  const boardNode = 'board:' + board;
  const ts = threads || [];

  // ── Prompts: one per (sender, cmd_id), the first seen (board.Inbox) ──
  const prompts = new Map<string, Prompt>();
  const keyOf = (from: string, id: string) => from + '\x00' + id;
  const all: { post: BoardPost; thread: BoardThread }[] = [];
  for (const t of ts) {
    if (t.root) all.push({ post: t.root, thread: t });
    for (const r of t.replies || []) if (r) all.push({ post: r, thread: t });
  }
  for (const { post } of all) {
    if (post.kind !== 'cmd' || !post.to_pane_id || !post.cmd_id) continue;
    const k = keyOf(post.pane_id, post.cmd_id);
    if (!prompts.has(k)) prompts.set(k, { cmd: post, undelivered: false });
  }
  // Answers: a non-cmd post BY the recipient on the cmd's thread, or the
  // recipient's ack naming the cmd (on its thread or with none).
  for (const { post } of all) {
    if (post.kind === 'cmd') continue;
    prompts.forEach((pr) => {
      const c = pr.cmd;
      if (post.kind === UNDELIVERED && post.thread_id && post.thread_id === c.thread_id) pr.undelivered = true;
      if (post.pane_id !== c.to_pane_id) return;
      let hit = !!post.thread_id && post.thread_id === c.thread_id;
      if (post.kind === 'ack') hit = post.cmd_id === c.cmd_id && (post.thread_id === c.thread_id || !post.thread_id);
      if (hit && (pr.answeredAt === undefined || post.ts < pr.answeredAt)) pr.answeredAt = post.ts;
    });
  }
  // The prompt a thread opened: its root, when that root is a cmd.
  const promptOfThread = (t: BoardThread): Prompt | undefined =>
    t.root && t.root.kind === 'cmd' && t.root.cmd_id ? prompts.get(keyOf(t.root.pane_id, t.root.cmd_id)) : undefined;

  // ── Events, oldest first (stable) ──
  const sorted = all.map((x, i) => ({ ...x, i })).sort((a, b) => a.post.ts - b.post.ts || a.i - b.i);
  const events: FlowEvent[] = [];
  for (const { post, thread } of sorted) {
    const pr = post.kind === 'cmd' ? undefined : promptOfThread(thread);
    const base = { ts: post.ts, kind: post.kind, thread: post.thread_id || thread.key, summary: flowSummary(post.text) };
    let ev: FlowEvent;
    if (post.kind === 'cmd' && post.to_pane_id) {
      ev = { ...base, type: 'prompt', from: post.pane_id, to: post.to_pane_id, cmd_id: post.cmd_id || undefined };
    } else if (pr && post.kind === 'ack') {
      ev = { ...base, type: 'ack', from: post.pane_id, to: pr.cmd.pane_id, cmd_id: pr.cmd.cmd_id };
    } else if (pr && post.kind === UNDELIVERED) {
      ev = { ...base, type: 'undelivered', from: post.pane_id, to: pr.cmd.to_pane_id!, cmd_id: pr.cmd.cmd_id };
    } else if (pr) {
      const other = post.pane_id === pr.cmd.to_pane_id ? pr.cmd.pane_id : pr.cmd.to_pane_id!;
      ev = { ...base, type: 'reply', from: post.pane_id, to: other, cmd_id: pr.cmd.cmd_id };
    } else {
      ev = { ...base, type: 'status', from: post.pane_id, to: boardNode };
    }
    if (!ev.cmd_id) delete ev.cmd_id;
    events.push(orderEvent(ev));
  }

  // ── Nodes ──
  const paneById = new Map(panes.map((p) => [p.id, p]));
  const latestPersona = new Map<string, string>();
  const postCount = new Map<string, number>();
  for (const { post } of sorted) {
    const persona = sanitiseInline(post.persona).trim();
    if (persona) latestPersona.set(post.pane_id, persona);
    postCount.set(post.pane_id, (postCount.get(post.pane_id) || 0) + 1);
  }
  const nodes: FlowNode[] = [{ id: boardNode, kind: 'board', label: board, posts: 0 }];
  const index = new Map<string, number>([[boardNode, 0]]);
  const addNode = (id: string) => {
    if (index.has(id)) return;
    let n: FlowNode;
    if (RELAYS.has(id)) {
      n = { id, kind: id as FlowNodeKind, label: id, posts: postCount.get(id) || 0 };
    } else {
      const p = paneById.get(id);
      const meta = p?.meta || {};
      n = {
        id,
        kind: 'pane',
        label: latestPersona.get(id) || p?.name || boardPersona('', id),
        role: meta['fleet.role'] || undefined,
        parent: meta['fleet.parent'] || undefined,
        comm: normaliseComm(meta['fleet.comm']),
        posts: postCount.get(id) || 0,
        work: meta['fleet.work'] || undefined,
        task: sanitiseInline(meta['fleet.task'] || '') || undefined,
        activity: meta['fleet.activity'] || undefined,
        health: meta['fleet.health'] || undefined,
      };
      const blockedBy = (meta['fleet.blocked_by'] || '')
        .split(',')
        .map((b) => b.trim())
        .filter((b) => b !== '');
      if (blockedBy.length) n.blocked_by = blockedBy;
      const goalState = sanitiseInline(meta['fleet.goal_state'] || '');
      if (goalState) n.goal_state = goalState;
      const pct = /^\s*\d+\s*$/.test(meta['fleet.goal_pct'] || '') ? parseInt(meta['fleet.goal_pct'], 10) : NaN;
      if (pct >= 0 && pct <= 100) n.goal_pct = pct;
      const eta = /^\s*\d+\s*$/.test(meta['fleet.goal_eta'] || '') ? parseInt(meta['fleet.goal_eta'], 10) : NaN;
      if (eta > 0) n.goal_eta = eta;
    }
    index.set(id, nodes.length);
    nodes.push(orderNode(n));
  };
  for (const ev of events) {
    addNode(ev.from);
    if (ev.to !== boardNode) addNode(ev.to);
  }
  panes
    .filter((p) => (p.meta || {})['board.id'] === board && !index.has(p.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .forEach((p) => addNode(p.id));

  // ── Edges ──
  const edges = new Map<string, FlowEdge & { lat?: number[] }>();
  const edge = (type: FlowEdgeType, from: string, to: string) => {
    const k = `${type}\x00${from}\x00${to}`;
    let e = edges.get(k);
    if (!e) {
      e = { type, from, to, count: 0 };
      if (type === 'prompt') Object.assign(e, { answered: 0, undelivered: 0, open: 0, lat: [] });
      edges.set(k, e);
    }
    return e;
  };
  for (const n of nodes) {
    if (n.kind === 'pane' && n.parent && index.has(n.parent)) edge('chain', n.parent, n.id).count = 1;
  }
  for (const n of nodes) {
    if (n.kind !== 'pane') continue;
    for (const b of n.blocked_by || []) if (b !== n.id && index.has(b)) edge('blocks', n.id, b).count = 1;
  }
  prompts.forEach((pr) => {
    const e = edge('prompt', pr.cmd.pane_id, pr.cmd.to_pane_id!);
    e.count++;
    if (pr.answeredAt !== undefined) {
      e.answered!++;
      const lat = pr.answeredAt - pr.cmd.ts;
      if (lat >= 0) e.lat!.push(lat);
    } else if (pr.undelivered) e.undelivered!++;
    else e.open!++;
    e.last_ts = Math.max(e.last_ts ?? 0, pr.cmd.ts);
  });
  for (const ev of events) {
    if (ev.type !== 'undelivered' && ev.type !== 'status') continue;
    const e = edge(ev.type, ev.from, ev.to);
    e.count++;
    e.last_ts = Math.max(e.last_ts ?? 0, ev.ts);
  }
  const out = [...edges.values()]
    .sort(
      (a, b) =>
        EDGE_ORDER.indexOf(a.type) - EDGE_ORDER.indexOf(b.type) ||
        index.get(a.from)! - index.get(b.from)! ||
        index.get(a.to)! - index.get(b.to)!
    )
    .map(({ lat, ...e }) => {
      if (lat && lat.length) e.latency_ms = median(lat);
      return orderEdge(e);
    });

  // ── Stats ──
  let answered = 0;
  let undelivered = 0;
  let open = 0;
  for (const e of out) {
    if (e.type !== 'prompt') continue;
    answered += e.answered!;
    undelivered += e.undelivered!;
    open += e.open!;
  }
  const stats: FlowStats = {
    panes: nodes.filter((n) => n.kind === 'pane').length,
    prompts: prompts.size,
    answered,
    undelivered,
    open,
    status: events.filter((e) => e.type === 'status').length,
  };
  const blocked = nodes.filter((n) => n.kind === 'pane' && n.work === 'blocked').length;
  if (blocked) stats.blocked = blocked;
  return { board, nodes, edges: out, events: events.slice(-FLOW_MAX_EVENTS), stats };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.floor((s[m - 1] + s[m]) / 2);
}

// Field order as §3.7 lists it, so a serialised flow reads like the fixture
// (the test compares structurally; this is for humans diffing JSON).
function orderNode(n: FlowNode): FlowNode {
  const o: FlowNode = { id: n.id, kind: n.kind, label: n.label, posts: 0 };
  if (n.role) o.role = n.role;
  if (n.parent) o.parent = n.parent;
  if (n.comm) o.comm = n.comm;
  delete (o as Partial<FlowNode>).posts;
  o.posts = n.posts;
  if (n.work) o.work = n.work;
  if (n.task) o.task = n.task;
  if (n.activity) o.activity = n.activity;
  if (n.health) o.health = n.health;
  if (n.blocked_by && n.blocked_by.length) o.blocked_by = n.blocked_by;
  if (n.goal_state) o.goal_state = n.goal_state;
  if (n.goal_pct !== undefined) o.goal_pct = n.goal_pct;
  if (n.goal_eta !== undefined) o.goal_eta = n.goal_eta;
  return o;
}

function orderEdge(e: FlowEdge): FlowEdge {
  const o: FlowEdge = { type: e.type, from: e.from, to: e.to, count: e.count };
  if (e.type === 'prompt') Object.assign(o, { answered: e.answered, undelivered: e.undelivered, open: e.open });
  if (e.latency_ms !== undefined) o.latency_ms = e.latency_ms;
  if (e.last_ts !== undefined) o.last_ts = e.last_ts;
  return o;
}

function orderEvent(e: FlowEvent): FlowEvent {
  const o: FlowEvent = { ts: e.ts, type: e.type, from: e.from, to: e.to, kind: e.kind, thread: e.thread, summary: '' };
  delete (o as Partial<FlowEvent>).summary;
  if (e.cmd_id) o.cmd_id = e.cmd_id;
  o.summary = e.summary;
  return o;
}
