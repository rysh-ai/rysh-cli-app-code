import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LaneStrip } from './LaneStrip';
import { useStore, resolveFocus } from '../store';
import { isLaneFolded, laneFrontPane, laneOfPane, laneStripLabel, openLanes } from '../utils/lanes';
import type { LaneSnapshot, PaneSnapshot, TabSnapshot, WorkspaceSnapshot } from '../types';

// Design 053 in the desktop app: a folded lane draws as a strip, gives its width
// to the open lanes, and opens on a click — the same messages the TUI sends.

const pane = (id: string, over: Partial<PaneSnapshot> = {}) => ({ id, enabled_modes: ['shell'], ...over }) as PaneSnapshot;
const lane = (id: string, paneIDs: string[], over: Partial<LaneSnapshot> = {}): LaneSnapshot => ({
  id,
  flex: 1,
  active_pane_id: paneIDs[0] || '',
  pane_groups: [{ id: `${id}-g`, active_pane_id: paneIDs[0] || '', panes: paneIDs.map((p) => pane(p)) }],
  ...over,
});
const tab = (lanes: LaneSnapshot[]): TabSnapshot => ({ id: 't', title: 't', active_pane_id: '', lanes, pipeline_name: 'pipe' });

afterEach(() => {
  cleanup();
  useStore.setState({ ws: null });
});

describe('lane helpers', () => {
  it('a collapsed lane folds while another lane is open', () => {
    const t = tab([lane('l1', ['a']), lane('l2', ['b'], { collapsed: true }), lane('l3', ['c'])]);
    expect(isLaneFolded(t, t.lanes[1])).toBe(true);
    expect(openLanes(t).map((l) => l.id)).toEqual(['l1', 'l3']);
  });

  it('every lane collapsed draws them all open (the TUI rule)', () => {
    const t = tab([lane('l1', ['a'], { collapsed: true }), lane('l2', ['b'], { collapsed: true })]);
    expect(openLanes(t)).toHaveLength(2);
  });

  it('labels a strip with its 1-based index and name, falling back to the pipeline name', () => {
    const t = tab([lane('l1', ['a']), lane('l2', ['b'], { name: 'build' }), lane('l3', ['c'])]);
    expect(laneStripLabel(t, t.lanes[1])).toBe('2 build');
    expect(laneStripLabel(t, t.lanes[2])).toBe('3 pipe');
  });

  it('finds a pane\'s lane and a lane\'s front pane', () => {
    const t = tab([lane('l1', ['a']), lane('l2', ['b', 'c'], { active_pane_id: 'c' })]);
    expect(laneOfPane(t, 'c')?.id).toBe('l2');
    expect(laneFrontPane(t.lanes[1])).toBe('c');
    expect(laneFrontPane(lane('l9', ['x'], { active_pane_id: 'gone' }))).toBe('x');
  });
});

describe('LaneStrip', () => {
  it('shows the label and opens + focuses the lane on click', () => {
    const sent: unknown[] = [];
    useStore.setState({ ws: { readyState: WebSocket.OPEN, send: (d: string) => sent.push(JSON.parse(d)) } as unknown as WebSocket });
    const focus = vi.spyOn(useStore.getState(), 'focusPane');
    const t = tab([lane('l1', ['a']), lane('l2', ['b'], { collapsed: true, name: 'build' })]);
    render(<LaneStrip tab={t} lane={t.lanes[1]} activePaneId="a" />);
    const strip = screen.getByTestId('lane-strip');
    expect(strip.textContent).toBe('2 build');
    fireEvent.click(strip);
    expect(sent).toEqual([
      { type: 'command', data: { action: 'lane_collapse', params: { verb: 'expand', lane: 'l2' } } },
      { type: 'command', data: { action: 'focus_pane_by_id', params: { id: 'b' } } },
    ]);
    expect(focus).toHaveBeenCalledWith('b');
    focus.mockRestore();
    expect(useStore.getState().focusedPaneID).toBe('b');
  });
});

describe('resolveFocus with a folded lane', () => {
  it('a focused pane inside a folded lane falls back to the daemon\'s focus', () => {
    const s: WorkspaceSnapshot = {
      active_tab_id: 't',
      active_pane_id: 'a',
      tabs: [tab([lane('l1', ['a']), lane('l2', ['b'], { collapsed: true })])],
    };
    expect(resolveFocus(s, 'b', 0, 1).focusedPaneID).toBe('a');
    expect(resolveFocus(s, 'a', 0, 1).focusedPaneID).toBe('a');
  });
});
