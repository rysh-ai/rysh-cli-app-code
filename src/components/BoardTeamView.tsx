import React, { useMemo, useState } from 'react';
import type { Flow } from '../board/flow';
import { buildFlowDeps } from '../board/flowDeps';
import {
  GOAL_ALARM,
  teamAge,
  teamGoalCell,
  teamGoalReport,
  teamHealth,
  teamHealthSummary,
  teamRows,
  TEAM_NO_LEDGER,
  TEAM_NO_MEMBERS,
  TEAM_NONE_BLOCKED,
  type TeamRow,
} from '../board/team';
import { BLOCKS_COLOUR, DependencyTree, HEALTH_COLOUR } from './BoardFlowView';

/**
 * BoardTeamView is the board pane's team view, `t` (design 054 §8b): every
 * fleet member in chain order — who is progressing, idle or blocked, how
 * healthy, when it last posted, what it is on or waiting for — and the
 * dependency tree under it.
 *
 * It renders board/team.ts, the port held to the same lines as the terminal's
 * `t` (rysh-cli internal/board/team.go), so the two cannot disagree about who
 * is a member, in which order, or what blocks them. Unlike the flow view's
 * dependency panel, the tree here is always drawn: "none blocked" is an answer,
 * and a section that vanishes when empty reads as a feature that is missing.
 */

const WORK_COLOUR: Record<string, string> = {
  blocked: BLOCKS_COLOUR,
  progress: '#5fd787',
  done: '#808080',
};
const ACTIVITY_COLOUR: Record<string, string> = { working: '#87d7af', idle: '#909090' };
const OK_COLOUR = '#5fd787';

function healthColour(h?: string): string | undefined {
  if (!h) return undefined;
  return h === 'ok' ? OK_COLOUR : HEALTH_COLOUR[h] || '#d7af5f';
}

export const BoardTeamView = React.memo(function BoardTeamView({ flow, now }: { flow: Flow; now: number }) {
  const rows = useMemo(() => teamRows(flow), [flow]);
  const deps = useMemo(() => buildFlowDeps(flow), [flow]);
  const [focus, setFocus] = useState<string | null>(null);
  const toggle = (id: string) => setFocus((f) => (f === id ? null : id));

  if (rows.length === 0) {
    return (
      <div className="p-3 text-[12px] text-[#808080]" data-testid="board-team">
        {TEAM_NO_MEMBERS.map((l) => (
          <div key={l}>{l}</div>
        ))}
      </div>
    );
  }

  const health = teamHealthSummary(rows);
  // The goal executor (design 055): its column and its newest report, only
  // when one runs.
  const goals = rows.some((r) => !!r.goalState);
  const report = teamGoalReport(flow);
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden" data-testid="board-team">
      <div className="px-3 py-1 text-[11px] text-[#808080] border-b border-[#333] shrink-0">
        {rows.length} member{rows.length === 1 ? '' : 's'} ·{' '}
        <span style={{ color: deps.blocked ? BLOCKS_COLOUR : undefined }}>
          {deps.blocked ? `${deps.blocked} blocked` : 'none blocked'}
        </span>{' '}
        · <span data-testid="board-team-health">{health || TEAM_NO_LEDGER}</span>
      </div>
      {report && (
        <div className="px-3 py-1 text-[11px] border-b border-[#333] shrink-0 text-[#d0d0d0]" data-testid="board-team-goal-report">
          <span className="text-[#af87ff]">goal executor</span> · {report}
        </div>
      )}

      <div className="min-h-0 overflow-auto shrink" style={{ maxHeight: '65%' }}>
        <table className="w-full text-[11px] border-collapse" data-testid="board-team-table">
          <thead className="sticky top-0 bg-[#1a1a1a] text-[#a0a0a0]">
            <tr>
              {['member', 'role', 'work', 'activity', 'health', ...(goals ? ['goal'] : []), 'last post', 'task / blocking'].map((h) => (
                <th key={h} className="text-left font-normal uppercase tracking-wide px-2 py-1 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <TeamTableRow key={r.id} row={r} now={now} focused={focus === r.id} onFocus={toggle} goals={goals} />
            ))}
          </tbody>
        </table>
      </div>

      {deps.blocked > 0 ? (
        <DependencyTree
          deps={deps}
          focus={focus}
          onFocus={toggle}
          className="flex-1 min-h-0 overflow-auto border-t border-[#333]"
          testId="board-team-deps"
        />
      ) : (
        <div className="border-t border-[#333] px-3 py-1.5 text-[11px] font-mono text-[#a0a0a0]" data-testid="board-team-deps">
          {TEAM_NONE_BLOCKED}
        </div>
      )}
    </div>
  );
});

function TeamTableRow({
  row: r,
  now,
  focused,
  onFocus,
  goals,
}: {
  row: TeamRow;
  now: number;
  focused: boolean;
  onFocus: (id: string) => void;
  goals: boolean;
}) {
  const dim = (s?: string) => s || <span className="text-[#555]">-</span>;
  const h = teamHealth(r.health);
  return (
    <tr
      className={`border-t border-[#262626] align-baseline ${focused ? 'bg-[#2a2a3a]' : 'hover:bg-[#222]'}`}
      data-member={r.id}
      data-work={r.work || undefined}
    >
      <td className="px-2 py-0.5 whitespace-nowrap" style={{ paddingLeft: 8 + r.depth * 14 }}>
        {r.depth > 0 && <span className="text-[#606060]">└─ </span>}
        <button
          type="button"
          className={`hover:underline ${focused ? 'text-white font-bold' : 'text-[#e0e0e0]'}`}
          onClick={() => onFocus(r.id)}
          title={r.id}
        >
          {r.label}
        </button>
      </td>
      <td className="px-2 py-0.5 whitespace-nowrap text-[#909090]">{dim(r.role)}</td>
      <td className="px-2 py-0.5 whitespace-nowrap" style={{ color: r.work ? WORK_COLOUR[r.work] || '#c0c0c0' : undefined }}>
        {dim(r.work)}
      </td>
      <td className="px-2 py-0.5 whitespace-nowrap" style={{ color: r.activity ? ACTIVITY_COLOUR[r.activity] || '#c0c0c0' : undefined }}>
        {dim(r.activity)}
      </td>
      <td className="px-2 py-0.5 whitespace-nowrap" style={{ color: healthColour(r.health) }} data-health={r.health || undefined}>
        {dim(h)}
      </td>
      {goals && (
        <td
          className="px-2 py-0.5 whitespace-nowrap"
          style={{ color: r.goalState && GOAL_ALARM.has(r.goalState) ? HEALTH_COLOUR.stalled : r.goalState === 'blocker' ? BLOCKS_COLOUR : '#c0c0c0' }}
          data-goal={r.goalState || undefined}
        >
          {dim(teamGoalCell(r, now))}
        </td>
      )}
      <td className="px-2 py-0.5 whitespace-nowrap text-[#909090]" title={r.lastPost ? new Date(r.lastPost).toLocaleString() : undefined}>
        {teamAge(r.lastPost, now)}
      </td>
      <td className="px-2 py-0.5 text-[#c8c8c8]" data-task>
        {r.blockedBy.length > 0 && (
          <span style={{ color: BLOCKS_COLOUR }} data-blocked-by>
            ⧗ {r.blockedBy.join(', ')}
            {r.task ? ' · ' : ''}
          </span>
        )}
        {r.task}
      </td>
    </tr>
  );
}
