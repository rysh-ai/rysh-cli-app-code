import React, { useMemo, useState } from 'react';
import type { Flow, FlowEdge, FlowEvent, FlowNode } from '../board/flow';
import { buildFlowDeps, cycleLine, depBadge, depHeadline, type FlowDepNode, type FlowDeps } from '../board/flowDeps';

/**
 * BoardFlowView draws a board's traffic (design 052): a GRAPH of who orders
 * whom — the fleet chain, prompt edges coloured by state, status into the
 * board — and below it a SEQUENCE FLOW of the events in order.
 *
 * It renders a Flow and nothing else: the model (board/flow.ts) is the port
 * held to the same golden fixture as the terminal's `f` view, so the two
 * cannot disagree about what happened, only about how it looks.
 */

const W = 760; // graph viewBox width; the SVG scales to the pane
const ROW = 92;
const NODE_W = 128;
const NODE_H = 34;
const NODE_GAP = 16; // minimum horizontal space between two nodes in a row
const PULSE_MS = 10_000;

const STATE_COLOUR = { answered: '#5fd787', open: '#d7af5f', undelivered: '#ff8787' } as const;

// The fleet status ledger (design 054). Blocks edges and health borders use
// their own colours so a dependency never reads as a prompt.
export const BLOCKS_COLOUR = '#ff5f87';
export const BOTTLENECK_COLOUR = '#ffaf5f';
export const HEALTH_COLOUR: Record<string, string> = {
  stalled: '#d7af5f',
  silent: '#8a8a8a',
  unblocked: '#5fd787',
  deadlock: '#ff5f5f',
  unresponsive: '#ff5f5f',
  available: '#5fafff',
};

/** "progress·STALLED", "blocked·idle", "done·AVAILABLE" — '' with no ledger. */
export function statusBadge(n: FlowNode): string {
  if (!n.work && !n.health) return '';
  const parts = n.work ? [n.work] : [];
  if (n.health && n.health !== 'ok') parts.push(n.health.toUpperCase());
  else if (n.activity && n.activity !== 'unknown') parts.push(n.activity);
  return parts.join('·');
}

interface Placed extends FlowNode {
  x: number;
  y: number;
}

/** Layers by chain depth; the board sits to the side, relays at the bottom. */
export function layoutFlow(flow: Flow): { nodes: Placed[]; height: number } {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const depthOf = (n: FlowNode, seen = new Set<string>()): number => {
    if (depth.has(n.id)) return depth.get(n.id)!;
    const parent = n.parent ? byId.get(n.parent) : undefined;
    // A cycle in fleet.parent is a bad manifest, not a reason to hang.
    const d = parent && !seen.has(n.id) ? depthOf(parent, seen.add(n.id)) + 1 : 0;
    depth.set(n.id, d);
    return d;
  };
  const panes = flow.nodes.filter((n) => n.kind === 'pane');
  const layers: FlowNode[][] = [];
  for (const n of panes) (layers[depthOf(n)] ||= []).push(n);
  const relays = flow.nodes.filter((n) => n.kind === 'courier' || n.kind === 'listener' || n.kind === 'fleet');
  const graphW = W - NODE_W - 40; // leave a column for the board
  // A layer wider than the graph WRAPS onto extra rows instead of squeezing:
  // spreading N nodes over a fixed width overlaps them once N > perRow (found
  // live: seven workers under one lead drew as one overlapping strip). A
  // partial wrapped row is spread across the width too, so its nodes fall
  // between the ones above and chain edges pass through the gaps.
  const perRow = Math.max(1, Math.floor(graphW / (NODE_W + NODE_GAP)));
  const rows: FlowNode[][] = [];
  for (const layer of [...layers.filter(Boolean), ...(relays.length ? [relays] : [])]) {
    for (let i = 0; i < layer.length; i += perRow) rows.push(layer.slice(i, i + perRow));
  }

  const placed: Placed[] = [];
  rows.forEach((row, r) => {
    row.forEach((n, i) => {
      placed.push({ ...n, x: ((i + 0.5) * graphW) / row.length, y: 30 + r * ROW });
    });
  });
  const height = Math.max(1, rows.length) * ROW;
  const board = flow.nodes.find((n) => n.kind === 'board');
  if (board) placed.push({ ...board, x: W - NODE_W / 2 - 12, y: Math.max(30, height / 2 - NODE_H) });
  return { nodes: placed, height: height + 10 };
}

/** Where the ray from a box's centre towards (tx, ty) leaves the box. */
export function borderPoint(cx: number, cy: number, tx: number, ty: number): [number, number] {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const t = Math.min(dx ? NODE_W / 2 / Math.abs(dx) : Infinity, dy ? NODE_H / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

/** The curve an edge is drawn on: border to border, prompt edges bowed. */
function edgeGeometry(e: FlowEdge, at: Map<string, Placed>) {
  const a = at.get(e.from);
  const b = at.get(e.to);
  if (!a || !b) return null;
  // Prompt edges bow to their right, perpendicular to the line, so A→B and
  // B→A sit side by side and a long edge clears the boxes it passes.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = e.type === 'prompt' ? 0.22 * len + 18 : 0;
  const mx = (a.x + b.x) / 2 - (dy / len) * bow;
  const my = (a.y + b.y) / 2 + NODE_H / 2 + (dx / len) * bow;
  // Leave and arrive at the box borders, towards the control point, so an
  // arrowhead is never drawn underneath a node.
  const [x1, y1] = borderPoint(a.x, a.y + NODE_H / 2, mx, my);
  const [x2, y2] = borderPoint(b.x, b.y + NODE_H / 2, mx, my);
  // The label sits on the curve in the gap just before the target's layer —
  // free space by construction — rather than at the middle, which on an edge
  // that skips a layer is on top of the node it skips.
  const t = len <= ROW * 1.2 ? 0.5 : 1 - (ROW * 0.45) / len;
  const lx = (1 - t) ** 2 * x1 + 2 * t * (1 - t) * mx + t ** 2 * x2;
  const ly = (1 - t) ** 2 * y1 + 2 * t * (1 - t) * my + t ** 2 * y2;
  return { mx, my, x1, y1, x2, y2, lx, ly };
}

function edgeColour(e: FlowEdge): string {
  if (e.type === 'blocks') return BLOCKS_COLOUR;
  if (e.type === 'undelivered' || (e.undelivered ?? 0) > 0) return STATE_COLOUR.undelivered;
  if ((e.open ?? 0) > 0) return STATE_COLOUR.open;
  if (e.type === 'prompt') return STATE_COLOUR.answered;
  if (e.type === 'status') return '#af87ff';
  return '#4a4a4a';
}

function secs(ms?: number): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function edgeLabel(e: FlowEdge): string {
  if (e.type !== 'prompt') return e.type === 'chain' ? '' : String(e.count);
  const parts = [`${e.count} prompt${e.count === 1 ? '' : 's'}`];
  if (e.answered) parts.push(`${e.answered} ✓`);
  if (e.open) parts.push(`${e.open} open`);
  if (e.undelivered) parts.push(`${e.undelivered} ✗`);
  if (e.latency_ms !== undefined) parts.push(`ack ${secs(e.latency_ms)}`);
  return parts.join(' · ');
}

const COMM_BADGE: Record<string, string> = { queue: 'queue', grid: 'grid', 'input-stream': 'typed' };

export const BoardFlowView = React.memo(function BoardFlowView({ flow, now }: { flow: Flow; now: number }) {
  const [focus, setFocus] = useState<string | null>(null);
  const { nodes, height } = useMemo(() => layoutFlow(flow), [flow]);
  const at = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const label = (id: string) => at.get(id)?.label ?? id.slice(0, 8);
  const s = flow.stats;
  // Design 054 §8a: who waits on whom, rooted at the bottleneck.
  const deps = useMemo(() => buildFlowDeps(flow), [flow]);
  const bottleneckId = deps.roots[0]?.id;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden" data-testid="board-flow">
      <div className="px-3 py-1 text-[11px] text-[#808080] border-b border-[#333] shrink-0">
        {s.panes} panes · {s.prompts} prompts (<span style={{ color: STATE_COLOUR.answered }}>{s.answered} answered</span>{' '}
        · <span style={{ color: STATE_COLOUR.undelivered }}>{s.undelivered} undelivered</span> ·{' '}
        <span style={{ color: STATE_COLOUR.open }}>{s.open} open</span>) · {s.status} status
        {s.blocked ? (
          <>
            {' · '}
            <span style={{ color: BLOCKS_COLOUR }}>{s.blocked} blocked</span>
          </>
        ) : null}
        {focus && (
          <button type="button" className="ml-2 text-[#8a8aaf] hover:text-white" onClick={() => setFocus(null)}>
            showing {label(focus)} · clear
          </button>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="w-full shrink-0 max-h-[55%]"
        role="img"
        aria-label={`communication graph of board ${flow.board}`}
      >
        <defs>
          {Object.entries({ ...STATE_COLOUR, status: '#af87ff', chain: '#4a4a4a', blocks: BLOCKS_COLOUR }).map(([k, c]) => (
            <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={c} />
            </marker>
          ))}
        </defs>
        <style>{`@keyframes rysh-flow-pulse { from { stroke-dashoffset: 24 } to { stroke-dashoffset: 0 } }
          .rysh-flow-live { stroke-dasharray: 6 6; animation: rysh-flow-pulse .8s linear infinite; }`}</style>

        {flow.edges.map((e, i) => {
          const geo = edgeGeometry(e, at);
          if (!geo) return null;
          const { mx, my, x1, y1, x2, y2 } = geo;
          const dim = focus && e.from !== focus && e.to !== focus;
          const colour = edgeColour(e);
          const markerKey =
            e.type === 'chain'
              ? 'chain'
              : e.type === 'status'
                ? 'status'
                : e.type === 'blocks'
                  ? 'blocks'
                  : colour === STATE_COLOUR.undelivered
                    ? 'undelivered'
                    : colour === STATE_COLOUR.open
                      ? 'open'
                      : 'answered';
          const live = e.last_ts !== undefined && now - e.last_ts < PULSE_MS && e.type !== 'chain' && e.type !== 'blocks';
          // Status is background traffic; orders are what the view is for.
          const width = e.type === 'chain' || e.type === 'status' ? 1 : 1.2 + Math.log2(1 + e.count);
          const faint = e.type === 'status' ? 0.45 : 1;
          return (
            <g key={i} opacity={dim ? 0.15 : faint} data-edge={`${e.type}:${e.from}:${e.to}`}>
              <path
                d={`M${x1},${y1} Q${mx},${my} ${x2},${y2}`}
                fill="none"
                stroke={colour}
                strokeWidth={width}
                strokeDasharray={e.type === 'chain' ? '3 4' : e.type === 'undelivered' ? '5 4' : e.type === 'blocks' ? '2 3' : undefined}
                className={live ? 'rysh-flow-live' : undefined}
                markerEnd={e.type === 'chain' ? undefined : `url(#arrow-${markerKey})`}
              >
                <title>
                  {e.type === 'blocks'
                    ? `${label(e.from)} is blocked by ${label(e.to)}`
                    : `${label(e.from)} → ${label(e.to)} · ${e.type} · ${edgeLabel(e) || 'fleet chain'}`}
                </title>
              </path>
            </g>
          );
        })}

        {nodes.map((n) => {
          const selected = focus === n.id;
          const fill = n.kind === 'board' ? '#2a1a3a' : n.kind === 'pane' ? '#1a2a24' : n.kind === 'fleet' ? '#1a2433' : '#3a1a1a';
          const health = n.health ? HEALTH_COLOUR[n.health] : undefined;
          const stroke = selected
            ? '#ffffff'
            : health ?? (n.kind === 'board' ? '#af87ff' : n.kind === 'pane' ? '#87d7af' : n.kind === 'fleet' ? '#5fafff' : '#ff8787');
          const badge = statusBadge(n);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x - NODE_W / 2},${n.y})`}
              className="cursor-pointer"
              onClick={() => setFocus(selected ? null : n.id)}
              data-node={n.id}
            >
              <title>
                {[
                  n.label,
                  n.role,
                  n.comm && `comm: ${n.comm}`,
                  n.work && `work: ${n.work}${n.task ? ' — ' + n.task : ''}`,
                  n.activity && `activity: ${n.activity}`,
                  n.health && `health: ${n.health}`,
                  n.blocked_by?.length && `blocked by: ${n.blocked_by.map(label).join(', ')}`,
                  `${n.posts} posts`,
                  n.id,
                ]
                  .filter(Boolean)
                  .join('\n')}
              </title>
              <rect width={NODE_W} height={NODE_H} rx="6" fill={fill} stroke={stroke} strokeWidth={selected || (health && n.health !== 'available') ? 2 : 1} />
              {n.id === bottleneckId && (
                <text x={4} y={-4} fontSize="9" fontWeight="bold" fill={BOTTLENECK_COLOUR} data-bottleneck="true">
                  ▣ BOTTLENECK · {deps.roots[0].waiting} waiting
                </text>
              )}
              {n.activity && n.activity !== 'unknown' && (
                <circle cx={NODE_W - 7} cy={7} r={3} fill={n.activity === 'working' ? '#5fd787' : '#6a6a6a'} data-activity={n.activity} />
              )}
              <text x={NODE_W / 2} y={14} textAnchor="middle" fontSize="11" fontWeight="bold" fill="#e0e0e0">
                {n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label}
              </text>
              <text x={NODE_W / 2} y={27} textAnchor="middle" fontSize="9" fill="#909090">
                {n.kind === 'pane'
                  ? badge || [n.role, n.comm && COMM_BADGE[n.comm]].filter(Boolean).join(' · ') || `${n.posts} posts`
                  : n.kind === 'fleet'
                    ? 'fleet actor'
                    : n.kind}
              </text>
            </g>
          );
        })}
        {/* Labels last, so a node never covers one. */}
        {flow.edges.map((e, i) => {
          if (e.type !== 'prompt') return null;
          const g = edgeGeometry(e, at);
          if (!g) return null;
          const dim = focus && e.from !== focus && e.to !== focus;
          return (
            <text
              key={`l${i}`}
              x={g.lx}
              y={g.ly - 4}
              textAnchor="middle"
              fontSize="10"
              fill={edgeColour(e)}
              stroke="#1e1e1e"
              strokeWidth={3}
              paintOrder="stroke"
              opacity={dim ? 0.15 : 1}
            >
              {edgeLabel(e)}
            </text>
          );
        })}
      </svg>

      {deps.blocked > 0 && <DependencyTree deps={deps} focus={focus} onFocus={(id) => setFocus(at.has(id) && focus !== id ? id : null)} />}

      <SequenceFlow flow={flow} focus={focus} label={label} now={now} />
    </div>
  );
});

/**
 * The dependency tree (design 054 §8a): roots are the blockers nobody blocks,
 * most agents waiting first — the first is the bottleneck. The same tree the
 * terminal's `f` view draws (board/flowDeps.ts is a port held to the same
 * lines); here an agent is clickable and focuses it in the graph above.
 */
export function DependencyTree({
  deps,
  focus,
  onFocus,
  className = 'shrink-0 max-h-[30%] overflow-auto border-t border-[#333]',
  testId = 'board-flow-deps',
}: {
  deps: FlowDeps;
  focus: string | null;
  onFocus: (id: string) => void;
  /** Where the tree sits: the flow view caps it under the graph; the team view lets it run. */
  className?: string;
  testId?: string;
}) {
  const row = (n: FlowDepNode, depth: number, key: string, root: boolean): React.ReactNode[] => {
    const badge = depBadge(n);
    const colour = n.health && HEALTH_COLOUR[n.health];
    const out: React.ReactNode[] = [
      <div
        key={key}
        className="flex items-baseline gap-2 whitespace-nowrap"
        style={{ paddingLeft: depth * 16 }}
        data-dep={n.id}
        data-dep-root={root || undefined}
      >
        <span className="text-[#606060]">{root ? '▣' : '└─'}</span>
        <button
          type="button"
          className={`hover:underline ${focus === n.id ? 'text-white font-bold' : root ? 'text-[#e0e0e0] font-bold' : 'text-[#c8c8c8]'}`}
          onClick={() => onFocus(n.id)}
        >
          {n.label}
        </button>
        {badge && <span style={{ color: colour || '#909090' }}>{badge}</span>}
        {n.waiting > 0 && <span style={{ color: BOTTLENECK_COLOUR }}>← {n.waiting} waiting</span>}
        {n.also.length > 0 && <span className="text-[#808080]">· also blocked by {n.also.join(', ')}</span>}
        {n.repeat && <span className="text-[#606060]">(see above)</span>}
      </div>,
    ];
    if (!n.repeat) n.children.forEach((c, i) => out.push(...row(c, depth + 1, `${key}/${i}`, false)));
    return out;
  };
  return (
    <div className={`${className} px-3 py-1.5 text-[11px] font-mono`} data-testid={testId}>
      <div className="text-[#a0a0a0] mb-1">{depHeadline(deps)}</div>
      {/* Deadlocks first: this panel scrolls, and nothing in a ring can move
          on its own — found live, a deadlock listed last sat below the fold. */}
      {deps.cycles.map((c, i) => (
        <div key={`c${i}`} className="whitespace-nowrap" style={{ color: HEALTH_COLOUR.deadlock }} data-dep-cycle>
          {cycleLine(c).trim()}
        </div>
      ))}
      {deps.roots.flatMap((r, i) => row(r, 0, `r${i}`, true))}
    </div>
  );
}

const EVENT_STYLE: Record<FlowEvent['type'], { colour: string; glyph: string }> = {
  prompt: { colour: STATE_COLOUR.answered, glyph: '──▶' },
  ack: { colour: '#87afff', glyph: '◀──' },
  reply: { colour: '#87afff', glyph: '◀──' },
  undelivered: { colour: STATE_COLOUR.undelivered, glyph: '╳' },
  status: { colour: '#af87ff', glyph: '●' },
};

/**
 * One lifeline per pane (board last), one row per event, oldest at the top
 * and the newest scrolled into view — the order things happened in, which the
 * graph above cannot show.
 */
function SequenceFlow({
  flow,
  focus,
  label,
  now,
}: {
  flow: Flow;
  focus: string | null;
  label: (id: string) => string;
  now: number;
}) {
  const lanes = useMemo(() => {
    const ids = flow.nodes.filter((n) => n.kind !== 'board').map((n) => n.id);
    const board = flow.nodes.find((n) => n.kind === 'board');
    return board ? [...ids, board.id] : ids;
  }, [flow]);
  const events = focus ? flow.events.filter((e) => e.from === focus || e.to === focus) : flow.events;
  const col = (id: string) => lanes.indexOf(id);
  const LANE = 110;
  const ROWH = 26;
  const width = Math.max(1, lanes.length) * LANE;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  if (events.length === 0) {
    return <div className="p-3 text-[12px] text-[#808080]">No traffic on this board yet.</div>;
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col border-t border-[#333]">
      <div className="overflow-x-auto shrink-0">
        <div className="flex text-[10px] text-[#d0d0d0] bg-[#1a1a1a]" style={{ width }}>
          {lanes.map((id) => (
            <div key={id} className="truncate text-center px-1 py-0.5" style={{ width: LANE }} title={id}>
              {label(id)}
            </div>
          ))}
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto" data-testid="board-flow-sequence">
        <svg width={width} height={events.length * ROWH + 8}>
          {lanes.map((id, i) => (
            <line key={id} x1={i * LANE + LANE / 2} x2={i * LANE + LANE / 2} y1={0} y2={events.length * ROWH + 8} stroke="#333" />
          ))}
          {events.map((e, r) => {
            const st = EVENT_STYLE[e.type];
            const y = r * ROWH + 18;
            const fx = col(e.from) * LANE + LANE / 2;
            const tx = col(e.to) * LANE + LANE / 2;
            const fresh = now - e.ts < PULSE_MS;
            const tip = `${new Date(e.ts).toLocaleTimeString()} · ${label(e.from)} → ${label(e.to)} · ${e.kind}${e.cmd_id ? ' · ' + e.cmd_id : ''}\n${e.summary}`;
            if (e.type === 'status' || col(e.from) < 0 || col(e.to) < 0) {
              return (
                <g key={r} data-event={e.type}>
                  <title>{tip}</title>
                  <circle cx={tx >= 0 ? tx : fx} cy={y - 4} r={fresh ? 5 : 3.5} fill={st.colour} />
                  <text x={fx + 6} y={y - 1} fontSize="10" fill="#b0b0b0">
                    {label(e.from)}: {e.summary.slice(0, 60)}
                  </text>
                </g>
              );
            }
            const left = Math.min(fx, tx);
            return (
              <g key={r} data-event={e.type}>
                <title>{tip}</title>
                <line
                  x1={fx}
                  x2={tx}
                  y1={y}
                  y2={y}
                  stroke={st.colour}
                  strokeWidth={fresh ? 2.5 : 1.5}
                  strokeDasharray={e.type === 'ack' || e.type === 'reply' ? '4 3' : undefined}
                />
                <path
                  d={tx > fx ? `M${tx},${y} l-7,-4 v8 z` : `M${tx},${y} l7,-4 v8 z`}
                  fill={st.colour}
                />
                {e.type === 'undelivered' && (
                  <text x={tx - 4} y={y + 4} fontSize="12" fill={st.colour}>
                    ✗
                  </text>
                )}
                <text x={left + 6} y={y - 4} fontSize="10" fill="#c0c0c0">
                  {e.cmd_id ? `${e.cmd_id} · ` : ''}
                  {e.summary.slice(0, Math.max(12, Math.abs(tx - fx) / 6))}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
