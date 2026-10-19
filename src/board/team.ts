import type { Flow, FlowNode } from './flow';
import { buildFlowDeps, renderFlowDeps, renderFlowDepsFit } from './flowDeps';
import { sanitiseInline } from './items';

// The team view (design 054 §8b, key t): the fleet status table — who is
// progressing, idle or blocked — and the dependency tree under it, on one
// screen. Read from the same ledger the fleet actor mirrors onto pane meta, so
// the table and the flow view's badges cannot disagree.
//
// A PORT of rysh-cli internal/board/team.go (TeamRows, RenderTeam,
// TeamCounts). The tests pin the same rendered lines the Go tests do, and the
// fixture's lines as the Go renderer draws them, so the terminal's `t` and this
// one show the same members in the same order with the same blockers.
//
// Unlike the flow view's dependency section, the tree here is ALWAYS drawn:
// "dependencies · none blocked" when nobody waits. A section that vanishes when
// it is empty reads as a feature that is missing.

export interface TeamRow {
  id: string;
  label: string;
  role?: string;
  work?: string;
  activity?: string;
  health?: string;
  task?: string;
  /** Labels, not ids: "human", "ext:<what>" and panes off this board stay as given. */
  blockedBy: string[];
  /** Unix millis of the member's newest post; 0 = none. */
  lastPost: number;
  /** Chain depth among the members, for the └─ indent. */
  depth: number;
  /** The goal executor's verdict (design 055); absent with no executor. */
  goalState?: string;
  goalPct?: number;
  goalEta?: number;
}

/**
 * The board's fleet members in chain order (each parent before its children).
 * A member is a pane that carries a fleet role or a ledger row; a pane that
 * only relayed a message (a human's coordinator) is not one.
 */
export function teamRows(f: Flow): TeamRow[] {
  const label = new Map<string, string>();
  for (const n of f.nodes) label.set(n.id, n.label);
  const last = new Map<string, number>();
  for (const e of f.events) if (e.ts > (last.get(e.from) || 0)) last.set(e.from, e.ts);

  const members = f.nodes.filter((n) => n.kind === 'pane' && !!(n.role || n.work || n.health || n.goal_state));
  const isMember = new Set(members.map((n) => n.id));
  const children = new Map<string, FlowNode[]>();
  const roots: FlowNode[] = [];
  for (const n of members) {
    if (n.parent && isMember.has(n.parent) && n.parent !== n.id) {
      children.set(n.parent, [...(children.get(n.parent) || []), n]);
    } else {
      roots.push(n);
    }
  }

  const out: TeamRow[] = [];
  const seen = new Set<string>();
  const walk = (n: FlowNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    out.push({
      id: n.id,
      label: sanitiseInline(n.label),
      role: n.role,
      work: n.work,
      activity: n.activity,
      health: n.health,
      task: n.task,
      blockedBy: (n.blocked_by || []).map((b) => sanitiseInline(label.get(b) || b)),
      lastPost: last.get(n.id) || 0,
      depth: 0,
      goalState: n.goal_state,
      goalPct: n.goal_pct,
      goalEta: n.goal_eta,
    });
    for (const c of children.get(n.id) || []) walk(c);
  };
  for (const n of roots) walk(n);
  for (const n of members) walk(n); // a parent cycle leaves members unreached

  const parent = new Map<string, string | undefined>(f.nodes.map((n) => [n.id, n.parent]));
  for (const r of out) {
    let d = 0;
    const visited = new Set([r.id]);
    for (let p = parent.get(r.id); p && isMember.has(p) && !visited.has(p); p = parent.get(p)) {
      visited.add(p);
      d++;
    }
    r.depth = d;
  }
  return out;
}

/** What the team view's header says: members and how many wait. */
export function teamCounts(f: Flow): { members: number; blocked: number } {
  return { members: teamRows(f).length, blocked: buildFlowDeps(f).blocked };
}

/** How long ago a post was: 12s, 4m, 3h, 2d; "-" for none. */
export function teamAge(tsMS: number, nowMS: number): string {
  if (tsMS <= 0) return '-';
  const s = Math.trunc((nowMS - tsMS) / 1000);
  if (s < 0) return '0s';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.trunc(s / 60)}m`;
  if (s < 86400) return `${Math.trunc(s / 3600)}h`;
  return `${Math.trunc(s / 86400)}d`;
}

/** The TASK / BLOCKING cell: a blocked member's blockers lead it. */
export function teamTask(r: TeamRow): string {
  const task = r.task || '';
  if (!r.blockedBy.length) return task;
  return '⧗ ' + r.blockedBy.join(', ') + (task ? ' · ' : '') + task;
}

/** Health as the badges show it: ok stays lower-case, anything else shouts. */
export function teamHealth(h?: string): string {
  return h && h !== 'ok' ? h.toUpperCase() : h || '';
}

/** "health: 3 ok · 1 STALLED…" counts in first-seen order; '' when no member has a ledger row. */
export function teamHealthSummary(rows: TeamRow[]): string {
  if (!rows.some((r) => r.work || r.health)) return '';
  const n = new Map<string, number>();
  for (const r of rows) {
    const k = r.health || 'no status';
    n.set(k, (n.get(k) || 0) + 1);
  }
  return 'health: ' + [...n].map(([k, c]) => `${c} ${k}`).join(' · ');
}

export const TEAM_NO_MEMBERS = [
  'no fleet members on this board — the team view lists panes that carry fleet.role',
  '(a fleet started with fleetctl up stamps it); s p a f show the board\'s messages.',
];
export const TEAM_NO_LEDGER = 'no status declared yet — members report it with `rysh fleet status` (design 054)';
export const TEAM_NONE_BLOCKED = 'dependencies · none blocked';

const runes = (s: string) => [...s].length;
const padRunes = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - runes(s)));

/**
 * The team view as plain lines, exactly as the terminal draws it: the table, a
 * health summary, then the dependency tree in at most depRows lines (0 = no
 * limit). nowMS dates the LAST POST column.
 */
export function renderTeam(f: Flow, nowMS: number, depRows = 0): string[] {
  const rows = teamRows(f);
  if (rows.length === 0) return [...TEAM_NO_MEMBERS];

  const names = rows.map((r) => (r.depth > 0 ? '   '.repeat(r.depth - 1) + '└─ ' + r.label : r.label));
  const nameW = Math.max(runes('MEMBER'), ...names.map(runes));
  const dash = (s?: string) => s || '-';
  // The GOAL column (design 055) only when a goal executor runs: a board
  // without one renders exactly as before.
  const goals = rows.some((r) => !!r.goalState);
  const line = (name: string, work: string, act: string, health: string, goal: string, lastPost: string, task: string) =>
    (
      padRunes(name, nameW) +
      '  ' +
      padRunes(work, 9) +
      ' ' +
      padRunes(act, 9) +
      ' ' +
      padRunes(health, 12) +
      ' ' +
      (goals ? padRunes(goal, 22) + ' ' : '') +
      padRunes(lastPost, 10) +
      ' ' +
      task
    ).replace(/ +$/, '');

  const out: string[] = [];
  const report = teamGoalReport(f);
  if (report) out.push('goal executor · ' + report);
  out.push(line('MEMBER', 'WORK', 'ACTIVITY', 'HEALTH', 'GOAL', 'LAST POST', 'TASK / BLOCKING'));
  rows.forEach((r, i) => {
    out.push(
      line(names[i], dash(r.work), dash(r.activity), dash(teamHealth(r.health)), dash(teamGoalCell(r, nowMS)), teamAge(r.lastPost, nowMS), teamTask(r))
    );
  });
  out.push(teamHealthSummary(rows) || TEAM_NO_LEDGER);

  out.push('');
  const deps = buildFlowDeps(f);
  if (deps.blocked === 0) return [...out, TEAM_NONE_BLOCKED];
  return [...out, ...(depRows > 0 ? renderFlowDepsFit(deps, depRows) : renderFlowDeps(deps))];
}

/**
 * A member's goal verdict (design 055): "blocker 40% eta 12m", "STRESSED",
 * "progressing OVERDUE 5m" — the conditions that need someone to act shout.
 */
export function teamGoalCell(r: Pick<TeamRow, 'goalState' | 'goalPct' | 'goalEta'>, nowMS: number): string {
  if (!r.goalState) return '';
  let s = ['stressed', 'strayed', 'deadlock', 'stalled'].includes(r.goalState) ? r.goalState.toUpperCase() : r.goalState;
  if (r.goalPct !== undefined) s += ` ${r.goalPct}%`;
  if (r.goalEta && r.goalEta > 0) {
    s += nowMS > r.goalEta ? ' OVERDUE ' + teamAge(r.goalEta, nowMS) : ' eta ' + teamAge(1, 1 + (r.goalEta - nowMS));
  }
  return s;
}

/** The first line of the newest goal-report on the board; '' when no executor has reported. */
export function teamGoalReport(f: Flow): string {
  for (let i = f.events.length - 1; i >= 0; i--) {
    if (f.events[i].kind === 'goal-report') return f.events[i].summary;
  }
  return '';
}

/** The conditions that need someone to act (design 055). */
export const GOAL_ALARM = new Set(['stressed', 'strayed', 'deadlock', 'stalled']);
