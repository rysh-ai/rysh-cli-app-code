import type { Flow, FlowNode } from './flow';
import { sanitiseInline } from './items';

// The dependency tree (design 054 §8a): who is waiting on whom, rooted at the
// bottlenecks — the blockers nobody blocks — ranked by how many agents wait on
// each, directly or transitively. The first root is the bottleneck.
//
// A PORT of rysh-cli internal/board/flow_deps.go (BuildFlowDeps,
// RenderFlowDeps, RenderFlowDepsFit). Derived from the flow's pane nodes'
// blocked_by only, so it adds nothing to 052's JSON contract; the tests pin the
// same rendered lines the Go tests do, so the terminal's `f` view and this one
// cannot disagree about where the bottleneck is.

export interface FlowDepNode {
  id: string;
  label: string;
  work?: string;
  activity?: string;
  health?: string;
  /** Distinct agents waiting on this one, directly or transitively. */
  waiting: number;
  /** This agent's OTHER blockers: unblocking the parent it is drawn under is not enough. */
  also: string[];
  /** Already drawn higher in the same root's tree (a diamond); subtree not repeated. */
  repeat: boolean;
  children: FlowDepNode[];
}

export interface FlowDepCycle {
  /** Labels in edge order: each is blocked by the next. */
  members: string[];
  /** Agents outside the ring that wait on it. */
  waiting: number;
  /** Pane ids of the members, for the graph. */
  ids: string[];
}

export interface FlowDeps {
  roots: FlowDepNode[];
  cycles: FlowDepCycle[];
  blocked: number;
}

export function buildFlowDeps(f: Flow): FlowDeps {
  const byId = new Map<string, FlowNode>();
  const order = new Map<string, number>();
  f.nodes.forEach((n, i) => {
    byId.set(n.id, n);
    order.set(n.id, i);
  });
  const blockedBy = new Map<string, string[]>();
  const waiters = new Map<string, string[]>();
  for (const n of f.nodes) {
    if (n.kind !== 'pane' || !n.blocked_by?.length) continue;
    for (const b of n.blocked_by) {
      if (!b || b === n.id) continue;
      blockedBy.set(n.id, [...(blockedBy.get(n.id) || []), b]);
      waiters.set(b, [...(waiters.get(b) || []), n.id]);
    }
  }
  const deps: FlowDeps = { roots: [], cycles: [], blocked: blockedBy.size };
  if (deps.blocked === 0) return deps;

  const label = (id: string): string => {
    const n = byId.get(id);
    if (n) return sanitiseInline(n.label);
    if (id === 'human' || id.startsWith('ext:')) return sanitiseInline(id);
    return id.length > 8 ? 'pane-' + id.slice(0, 8) : sanitiseInline(id);
  };
  const rank = (id: string) => order.get(id) ?? order.size;
  const sortIds = (ids: string[]) =>
    ids.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  waiters.forEach((ws) => sortIds(ws));

  const waitersOf = (...ids: string[]): number => {
    const seen = new Set(ids);
    const stack = ids.flatMap((id) => waiters.get(id) || []);
    let n = 0;
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      n++;
      stack.push(...(waiters.get(x) || []));
    }
    return n;
  };

  const build = (id: string, via: string, onPath: Set<string>, drawn: Set<string>): FlowDepNode => {
    const n = byId.get(id);
    const d: FlowDepNode = {
      id,
      label: label(id),
      work: n?.work,
      activity: n?.activity,
      health: n?.health,
      waiting: waitersOf(id),
      also: (blockedBy.get(id) || []).filter((b) => b !== via).map(label),
      repeat: false,
      children: [],
    };
    if (drawn.has(id)) {
      d.repeat = true;
      return d;
    }
    drawn.add(id);
    onPath.add(id);
    for (const w of waiters.get(id) || []) {
      if (onPath.has(w)) continue; // a ring hanging off this root: listed under cycles
      d.children.push(build(w, id, onPath, drawn));
    }
    onPath.delete(id);
    return d;
  };

  const roots = sortIds([...waiters.keys()].filter((b) => !(blockedBy.get(b) || []).length));
  deps.roots = roots.map((r) => build(r, '', new Set(), new Set()));
  // Stable: equal counts keep model order, as Go's sort.SliceStable does.
  deps.roots = deps.roots.map((r, i) => ({ r, i })).sort((a, b) => b.r.waiting - a.r.waiting || a.i - b.i).map((x) => x.r);

  for (const ring of depCycles(blockedBy, sortIds)) {
    deps.cycles.push({ members: ring.map(label), waiting: waitersOf(...ring), ids: ring });
  }
  return deps;
}

/** Every ring of blocked_by edges, once each, from its first member in model order. */
function depCycles(blockedBy: Map<string, string[]>, sortIds: (ids: string[]) => string[]): string[][] {
  const ids = sortIds([...blockedBy.keys()]);
  const colour = new Map<string, number>(); // 0 white, 1 grey, 2 black
  const inCycle = new Set<string>();
  const out: string[][] = [];
  const stack: string[] = [];
  const visit = (n: string) => {
    colour.set(n, 1);
    stack.push(n);
    for (const next of blockedBy.get(n) || []) {
      const c = colour.get(next) || 0;
      if (c === 0) visit(next);
      else if (c === 1) {
        const i = stack.lastIndexOf(next);
        const ring = stack.slice(i);
        if (!ring.some((id) => inCycle.has(id))) {
          ring.forEach((id) => inCycle.add(id));
          out.push(ring);
        }
      }
    }
    stack.pop();
    colour.set(n, 2);
  };
  for (const id of ids) if (!colour.get(id)) visit(id);
  return out;
}

export function bottleneck(d: FlowDeps): FlowDepNode | undefined {
  return d.roots[0];
}

/** "{progress·STALLED}" / "{blocked·idle}" — '' with no ledger. */
export function depBadge(n: Pick<FlowDepNode, 'work' | 'activity' | 'health'>): string {
  const parts: string[] = [];
  if (n.work) parts.push(n.work);
  if (n.health && n.health !== 'ok') parts.push(n.health.toUpperCase());
  else if (n.activity && n.activity !== 'unknown') parts.push(n.activity);
  return parts.length ? `{${parts.join('·')}}` : '';
}

export function depHeadline(d: FlowDeps): string {
  let head = `dependencies · ${d.blocked} blocked`;
  const b = bottleneck(d);
  if (b) head += ` · bottleneck: ${b.label} (${b.waiting} waiting)`;
  if (d.cycles.length) head += ` · ${d.cycles.length} deadlock${d.cycles.length > 1 ? 's' : ''}`;
  return head;
}

function depLine(n: FlowDepNode): string {
  let s = n.label;
  const badge = depBadge(n);
  if (badge) s += ' ' + badge;
  if (n.waiting > 0) s += `  ← ${n.waiting} waiting`;
  if (n.also.length) s += `  · also blocked by ${n.also.join(', ')}`;
  if (n.repeat) s += '  (see above)';
  return s;
}

export function cycleLine(c: FlowDepCycle): string {
  let line = '  ⟳ DEADLOCK  ' + [...c.members, c.members[0]].join(' → ');
  if (c.waiting > 0) line += ` · ${c.waiting} waiting on it`;
  return line;
}

/** The tree as plain lines, exactly as the terminal draws it; [] when nobody is blocked. */
export function renderFlowDeps(d: FlowDeps): string[] {
  if (d.blocked === 0) return [];
  const out = [depHeadline(d)];
  const walk = (n: FlowDepNode, prefix: string, last: boolean) => {
    out.push(prefix + (last ? '└─ ' : '├─ ') + depLine(n));
    if (n.repeat) return;
    n.children.forEach((c, i) => walk(c, prefix + (last ? '   ' : '│  '), i === n.children.length - 1));
  };
  for (const r of d.roots) {
    out.push('  ▣ ' + depLine(r));
    r.children.forEach((c, i) => walk(c, '    ', i === r.children.length - 1));
  }
  for (const c of d.cycles) out.push(cycleLine(c));
  return out;
}

/** At most maxRows lines: the full tree, else one line per root and deadlock, else cut. */
export function renderFlowDepsFit(d: FlowDeps, maxRows: number): string[] {
  const full = renderFlowDeps(d);
  if (full.length <= maxRows || maxRows <= 0) return full;
  const out = [full[0]];
  for (const r of d.roots) {
    let line = '  ▣ ' + depLine(r);
    if (r.children.length) line += '  ⇐ ' + r.children.map((c) => c.label).join(', ');
    out.push(line);
  }
  for (const c of d.cycles) out.push(cycleLine(c));
  if (out.length > maxRows) {
    const more = out.length - (maxRows - 1);
    return [...out.slice(0, maxRows - 1), `  … ${more} more — see \`rysh board tail --view flow\``];
  }
  return out;
}
