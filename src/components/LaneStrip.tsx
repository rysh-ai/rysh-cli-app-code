import type { LaneSnapshot, TabSnapshot } from '../types';
import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import { laneFrontPane, laneStripLabel } from '../utils/lanes';

// A folded lane (rysh-cli design 053): a thin bordered column with the lane's
// number and name running down it. Its width goes to the open lanes, which
// share it by flex exactly as the TUI's laneWidths does. Clicking it opens the
// lane and focuses its front pane — the same pair of messages the TUI's strip
// click sends.
export function LaneStrip({ tab, lane, activePaneId }: { tab: TabSnapshot; lane: LaneSnapshot; activePaneId: string }) {
  const panes = (lane.pane_groups || []).flatMap((g) => g.panes || []);
  const holdsFocus = panes.some((p) => p.id === activePaneId);
  const attention = panes.some((p) => (p.attention_count || 0) > 0);
  const label = laneStripLabel(tab, lane);
  const border = holdsFocus ? 'border-[#00d7d7]' : attention ? 'border-[#ffff00]' : 'border-[#3a3a3a]';

  const open = () => {
    const front = laneFrontPane(lane);
    sendCommand('lane_collapse', { verb: 'expand', lane: lane.id });
    if (front) {
      useStore.getState().focusPane(front);
      sendCommand('focus_pane_by_id', { id: front });
    }
  };

  return (
    <div
      data-testid="lane-strip"
      onClick={open}
      title={`lane ${label} (collapsed) — click to open`}
      className={`shrink-0 w-6 flex flex-col items-center py-2 rounded border ${border} bg-[#161616] hover:bg-[#222] cursor-pointer select-none overflow-hidden`}
    >
      <span
        className="text-[11px] text-[#9a9aaf] whitespace-nowrap"
        style={{ writingMode: 'vertical-rl' }}
      >
        {label}
      </span>
    </div>
  );
}
