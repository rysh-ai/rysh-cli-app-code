import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store';
import type { WorkspaceSnapshot, PaneSnapshot } from './types';

// A browser tab kept on a session for days got slower with every pane the
// session ever had: per-pane client state (output, VT screen, histories,
// web-pane frames, …) was never dropped when a pane closed, because a stream
// client only receives layout-only snapshots, which never reseed. setSnapshot
// now drops a pane's state once it is missing from two consecutive complete
// snapshots.

function pane(id: string): PaneSnapshot {
  return { id, enabled_modes: ['shell'] } as PaneSnapshot;
}

function snap(paneIDs: string[], opts: { partialTab?: boolean; tabId?: string } = {}): WorkspaceSnapshot {
  const tabId = opts.tabId ?? 't1';
  const tabs = [
    {
      id: tabId,
      title: tabId,
      active_pane_id: paneIDs[0] ?? '',
      lanes: [{ id: 'lane', flex: 1, active_pane_id: '', pane_groups: [{ id: 'g', active_pane_id: '', panes: paneIDs.map(pane) }] }],
    },
  ] as WorkspaceSnapshot['tabs'];
  if (opts.partialTab) tabs.push({ id: 't2', title: 't2', active_pane_id: '', lanes: [], partial: true } as never);
  return { active_tab_id: tabId, active_pane_id: paneIDs[0] ?? '', tabs } as WorkspaceSnapshot;
}

describe('setSnapshot prunes closed panes', () => {
  beforeEach(() => {
    useStore.setState({ snapshot: null, paneContent: {}, paneVT: {}, paneHistory: {}, pipelineOutputs: {}, webPaneFrames: {} });
    // Two complete snapshots with nothing in the store settle the module-level
    // bookkeeping left by other tests.
    useStore.getState().setSnapshot(snap([]), true);
    useStore.getState().setSnapshot(snap([]), true);
  });

  it('drops a pane missing from two consecutive snapshots, and only then', () => {
    const st = useStore.getState();
    st.setSnapshot(snap(['a', 'b']), true);
    st.appendPaneOutput('a', 'shell', 'hello a');
    st.appendPaneOutput('b', 'shell', 'hello b');
    st.setPaneVT('b', { raw_mode: true, vt_screen: ['x'] });

    useStore.getState().setSnapshot(snap(['a']), true); // b closed: first strike
    expect(useStore.getState().paneContent.b).toBeDefined();

    useStore.getState().setSnapshot(snap(['a']), true); // second strike
    expect(useStore.getState().paneContent.b).toBeUndefined();
    expect(useStore.getState().paneVT.b).toBeUndefined();
    expect(useStore.getState().paneContent.a?.output).toContain('hello a');
  });

  it('keeps output that arrives before the snapshot listing its pane', () => {
    useStore.getState().setSnapshot(snap(['a']), true);
    useStore.getState().appendPaneOutput('new', 'shell', 'first line'); // pane not listed yet
    useStore.getState().setSnapshot(snap(['a']), true); // stale snapshot: one strike only
    useStore.getState().setSnapshot(snap(['a', 'new']), true); // now listed: strike cleared
    useStore.getState().setSnapshot(snap(['a']), true);
    expect(useStore.getState().paneContent.new?.output).toContain('first line');
  });

  it('prunes nothing on the strength of a snapshot with a timed-out tab', () => {
    useStore.getState().setSnapshot(snap(['a', 'b']), true);
    useStore.getState().appendPaneOutput('b', 'shell', 'still here');
    useStore.getState().setSnapshot(snap(['a'], { partialTab: true }), true);
    useStore.getState().setSnapshot(snap(['a'], { partialTab: true }), true);
    expect(useStore.getState().paneContent.b?.output).toContain('still here');
  });

  it('keeps map identity when nothing closed', () => {
    useStore.getState().setSnapshot(snap(['a']), true);
    useStore.getState().appendPaneOutput('a', 'shell', 'x');
    const before = useStore.getState().paneContent;
    useStore.getState().setSnapshot(snap(['a']), true);
    expect(useStore.getState().paneContent).toBe(before);
  });

  it('drops pipeline output of a closed tab and caps it while live', () => {
    useStore.getState().setSnapshot(snap(['a'], { tabId: 't1' }), true);
    useStore.getState().appendPipelineOutput('t1', 'x'.repeat(50_000) + '\nend');
    expect(useStore.getState().pipelineOutputs.t1.length).toBeLessThanOrEqual(20_000);
    useStore.getState().appendPipelineOutput('gone', 'old');
    useStore.getState().setSnapshot(snap(['a'], { tabId: 't1' }), true);
    expect(useStore.getState().pipelineOutputs.gone).toBeUndefined();
    expect(useStore.getState().pipelineOutputs.t1).toBeDefined();
  });
});
