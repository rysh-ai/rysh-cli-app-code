import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, carryStalePanes } from './store';
import type { WorkspaceSnapshot, PaneSnapshot } from './types';

// With ~70 claude panes in one session, a pane whose actor missed the daemon's
// 1s snapshot deadline arrived as a zero-valued placeholder (raw_mode unset),
// and the active claude pane flipped to its shell view until the next on-time
// snapshot. The daemon now marks such entries `stale`, and the client keeps
// the pane as it last saw it.

function snap(panes: PaneSnapshot[]): WorkspaceSnapshot {
  return {
    active_tab_id: 't1',
    active_pane_id: panes[0]?.id ?? '',
    tabs: [
      {
        id: 't1',
        title: 't1',
        active_pane_id: panes[0]?.id ?? '',
        lanes: [{ id: 'lane', flex: 1, active_pane_id: '', pane_groups: [{ id: 'g', active_pane_id: '', panes }] }],
      },
    ],
  } as unknown as WorkspaceSnapshot;
}

const claude = { id: 'a', title: 'claude', enabled_modes: ['shell'], raw_mode: true, status: 'running' } as PaneSnapshot;
const placeholder = { id: 'a', title: 'a', status: 'unreachable', output: 'snapshot error: timeout', stale: true } as PaneSnapshot;

function paneA(s: WorkspaceSnapshot | null): PaneSnapshot | undefined {
  return s?.tabs[0].lanes[0].pane_groups[0].panes[0];
}

describe('carryStalePanes', () => {
  it('replaces a stale pane with the previous one', () => {
    const out = carryStalePanes(snap([claude]), snap([placeholder]));
    expect(paneA(out)?.raw_mode).toBe(true);
    expect(paneA(out)?.stale).toBeFalsy();
  });

  it('returns next unchanged when nothing is stale', () => {
    const next = snap([{ ...claude, raw_mode: false }]);
    expect(carryStalePanes(snap([claude]), next)).toBe(next);
  });

  it('keeps a stale pane it has never seen, still marked stale', () => {
    const out = carryStalePanes(snap([]), snap([placeholder]));
    expect(paneA(out)?.stale).toBe(true);
  });

  it('honours a real exit: an answered raw_mode=false is applied', () => {
    const out = carryStalePanes(snap([claude]), snap([{ ...claude, raw_mode: false }]));
    expect(paneA(out)?.raw_mode).toBe(false);
  });
});

describe('setSnapshot with a stale pane', () => {
  beforeEach(() => {
    useStore.setState({ snapshot: null, paneContent: {}, paneVT: {}, paneHistory: {}, pipelineOutputs: {}, webPaneFrames: {} });
  });

  it('a full snapshot with a stale pane keeps its VT state and content', () => {
    const st = useStore.getState();
    st.setSnapshot(snap([claude]), true);
    st.setPaneVT('a', { raw_mode: true, vt_screen: ['claude>'] });
    st.appendPaneOutput('a', 'shell', 'earlier output');

    useStore.getState().setSnapshot(snap([placeholder]), false);

    const after = useStore.getState();
    expect(paneA(after.snapshot)?.raw_mode).toBe(true);
    expect(after.paneVT.a?.raw_mode).toBe(true);
    expect(after.paneVT.a?.vt_screen).toEqual(['claude>']);
    expect(after.paneContent.a?.output).toContain('earlier output');
  });
});
