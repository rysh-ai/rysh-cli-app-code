import type { LaneSnapshot, TabSnapshot } from '../types';

// Design 053 (rysh-cli): a lane can be folded to a strip. `collapsed` is
// daemon-owned (it rides on the snapshot's LaneSnapshot), so these helpers only
// read it; folding and opening go through sendCommand('lane_collapse').

/**
 * isLaneFolded reports whether a lane draws as a strip. Mirrors the TUI's
 * laneWidths: if every lane of the tab is collapsed (a state the daemon refuses
 * to create, but an older or degraded snapshot could carry) they all draw open,
 * so the tab is never left with nothing to type into.
 */
export function isLaneFolded(tab: TabSnapshot, lane: LaneSnapshot): boolean {
  if (!lane.collapsed) return false;
  return (tab.lanes || []).some((l) => !l.collapsed);
}

/** openLanes returns the lanes of a tab that draw open. */
export function openLanes(tab: TabSnapshot): LaneSnapshot[] {
  return (tab.lanes || []).filter((l) => !isLaneFolded(tab, l));
}

/** laneOfPane returns the lane holding a pane, or undefined. */
export function laneOfPane(tab: TabSnapshot, paneId: string): LaneSnapshot | undefined {
  for (const lane of tab.lanes || []) {
    for (const g of lane.pane_groups || []) {
      if ((g.panes || []).some((p) => p.id === paneId)) return lane;
    }
  }
  return undefined;
}

/**
 * laneFrontPane returns the pane a lane shows first: its active pane if that is
 * still in it, else the top pane of its first non-empty group.
 */
export function laneFrontPane(lane: LaneSnapshot): string {
  for (const g of lane.pane_groups || []) {
    if ((g.panes || []).some((p) => p.id === lane.active_pane_id)) return lane.active_pane_id;
  }
  for (const g of lane.pane_groups || []) {
    const gp = g.panes || [];
    if (gp.length === 0) continue;
    return g.active_pane_id && gp.some((p) => p.id === g.active_pane_id) ? g.active_pane_id : gp[0].id;
  }
  return '';
}

/** laneStripLabel is the text a folded lane shows: "<1-based index> <name>". */
export function laneStripLabel(tab: TabSnapshot, lane: LaneSnapshot): string {
  const idx = (tab.lanes || []).findIndex((l) => l.id === lane.id) + 1;
  const name = lane.name || tab.pipeline_name || '';
  return name ? `${idx} ${name}` : `${idx}`;
}
