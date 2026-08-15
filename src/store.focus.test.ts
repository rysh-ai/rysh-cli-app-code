import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, resolveFocus, FOCUS_FOLLOW_WINDOW_MS } from './store';
import { sendCommand } from './utils/commands';
import type { WorkspaceSnapshot, PaneSnapshot } from './types';

// The focus policy this file pins down: a pane doing WORK never takes the
// keyboard. Only a click or a navigation command the user issued in this window
// moves focus. See resolveFocus in store.ts.

function pane(id: string): PaneSnapshot {
  return { id, enabled_modes: ['shell'] } as PaneSnapshot;
}

/** snap('t1', ['p1','p2'], 'p1') — one tab, one lane, one group. */
function snap(tabId: string, paneIDs: string[], active: string): WorkspaceSnapshot {
  return {
    active_tab_id: tabId,
    active_pane_id: active,
    tabs: [
      {
        id: tabId,
        title: tabId,
        active_pane_id: active,
        lanes: [
          {
            id: `${tabId}-lane`,
            flex: 1,
            active_pane_id: active,
            pane_groups: [
              { id: `${tabId}-grp`, active_pane_id: active, panes: paneIDs.map(pane) },
            ],
          },
        ],
      },
    ],
  };
}

const NOW = 1_000_000;

describe('resolveFocus', () => {
  it('seeds from the daemon when nothing is focused yet', () => {
    const r = resolveFocus(snap('t1', ['p1', 'p2'], 'p2'), null, 0, NOW);
    expect(r.focusedPaneID).toBe('p2');
  });

  it('ignores a daemon focus move while unarmed — the bug this fixes', () => {
    // p2 does some work and the daemon focuses it. The user is typing in p1.
    const r = resolveFocus(snap('t1', ['p1', 'p2'], 'p2'), 'p1', 0, NOW);
    expect(r.focusedPaneID).toBe('p1');
  });

  it('ignores a pane the daemon created and focused', () => {
    // An agent in p2 spawns p3; the daemon focuses the new pane.
    const r = resolveFocus(snap('t1', ['p1', 'p2', 'p3'], 'p3'), 'p1', 0, NOW);
    expect(r.focusedPaneID).toBe('p1');
  });

  it('adopts the daemon move inside an armed follow window, then disarms', () => {
    const armed = NOW + FOCUS_FOLLOW_WINDOW_MS;
    const r = resolveFocus(snap('t1', ['p1', 'p2'], 'p2'), 'p1', armed, NOW);
    expect(r.focusedPaneID).toBe('p2');
    expect(r.followDaemonUntil).toBe(0);
  });

  it('stays armed while the daemon has not moved yet', () => {
    // The snapshot in flight when the arrow key was pressed still reports p1.
    const armed = NOW + FOCUS_FOLLOW_WINDOW_MS;
    const r = resolveFocus(snap('t1', ['p1', 'p2'], 'p1'), 'p1', armed, NOW);
    expect(r.focusedPaneID).toBe('p1');
    expect(r.followDaemonUntil).toBe(armed);
  });

  it('drops an expired arm without following', () => {
    const stale = NOW - 1;
    const r = resolveFocus(snap('t1', ['p1', 'p2'], 'p2'), 'p1', stale, NOW);
    expect(r.focusedPaneID).toBe('p1');
    expect(r.followDaemonUntil).toBe(0);
  });

  it('follows the daemon when the focused pane is closed', () => {
    const r = resolveFocus(snap('t1', ['p2'], 'p2'), 'p1', 0, NOW);
    expect(r.focusedPaneID).toBe('p2');
  });

  it('follows the daemon when the visible tab no longer holds the pane', () => {
    const s = snap('t2', ['p9'], 'p9');
    const r = resolveFocus(s, 'p1', 0, NOW);
    expect(r.focusedPaneID).toBe('p9');
  });

  it('keeps focus on a degraded snapshot that carries no panes', () => {
    // A timed-out cascade leg: missing information, not a closed pane.
    const s = snap('t1', [], 'p2');
    const r = resolveFocus(s, 'p1', 0, NOW);
    expect(r.focusedPaneID).toBe('p1');
  });

  it('keeps focus when the daemon reports no active pane at all', () => {
    const r = resolveFocus(snap('t1', ['p1', 'p2'], ''), 'p1', 0, NOW);
    expect(r.focusedPaneID).toBe('p1');
  });
});

describe('store focus integration', () => {
  beforeEach(() => {
    useStore.setState({ focusedPaneID: null, followDaemonUntil: 0, snapshot: null, ws: null });
  });

  it('holds the clicked pane across snapshots that focus a busy pane', () => {
    const s = useStore.getState();
    s.setSnapshot(snap('t1', ['p1', 'p2'], 'p1'));
    s.focusPane('p1');
    // p2 churns and the daemon hands it focus, repeatedly.
    s.setSnapshot(snap('t1', ['p1', 'p2'], 'p2'));
    s.setSnapshot(snap('t1', ['p1', 'p2'], 'p2'), true);
    expect(useStore.getState().getEffectiveActivePaneID()).toBe('p1');
  });

  it('a click closes an armed follow window', () => {
    const s = useStore.getState();
    s.setSnapshot(snap('t1', ['p1', 'p2'], 'p1'));
    s.armFocusFollow();
    s.focusPane('p1');
    expect(useStore.getState().followDaemonUntil).toBe(0);
    s.setSnapshot(snap('t1', ['p1', 'p2'], 'p2'));
    expect(useStore.getState().getEffectiveActivePaneID()).toBe('p1');
  });

  it('arms only for the commands whose landing pane the daemon computes', () => {
    const sent: string[] = [];
    useStore.setState({
      ws: {
        readyState: 1,
        send: (raw: string) => sent.push(JSON.parse(raw).data.action),
      } as unknown as WebSocket,
    });

    sendCommand('pane_resize', { cols: 80 });
    expect(useStore.getState().followDaemonUntil).toBe(0);

    sendCommand('focus_pane_by_id', { id: 'p1' });
    expect(useStore.getState().followDaemonUntil).toBe(0);

    sendCommand('focus_pane_right');
    expect(useStore.getState().followDaemonUntil).toBeGreaterThan(Date.now());

    useStore.setState({ followDaemonUntil: 0 });
    sendCommand('create_pane');
    expect(useStore.getState().followDaemonUntil).toBeGreaterThan(Date.now());

    expect(sent).toEqual(['pane_resize', 'focus_pane_by_id', 'focus_pane_right', 'create_pane']);
  });

  it('follows arrow-key navigation end to end', () => {
    useStore.setState({
      ws: { readyState: 1, send: () => {} } as unknown as WebSocket,
    });
    const s = useStore.getState();
    s.setSnapshot(snap('t1', ['p1', 'p2'], 'p1'));
    s.focusPane('p1');
    sendCommand('focus_pane_right');
    s.setSnapshot(snap('t1', ['p1', 'p2'], 'p2'));
    expect(useStore.getState().getEffectiveActivePaneID()).toBe('p2');
    // …and the window is spent: the next daemon-side move is ignored again.
    s.setSnapshot(snap('t1', ['p1', 'p2'], 'p1'));
    expect(useStore.getState().getEffectiveActivePaneID()).toBe('p2');
  });

  it('clearSession drops the focused pane', () => {
    const s = useStore.getState();
    s.setSnapshot(snap('t1', ['p1'], 'p1'));
    s.focusPane('p1');
    s.clearSession();
    expect(useStore.getState().focusedPaneID).toBeNull();
  });
});
