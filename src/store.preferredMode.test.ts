import { describe, it, expect } from 'vitest';
import { useStore } from './store';
import type { WorkspaceSnapshot, PaneSnapshot } from './types';

// CD3 rehearsal note N1 (0.2.16; cli half rysh-cli e41a8b46): the daemon marks a
// pane's preferred mode (a company connect asks for 'company') in the pane
// snapshot, because its live activate push fires before an app attaches. The
// app applies it once per pane per window session, only if that mode is enabled
// and the user has not already picked a mode for the pane; it never sends back.

function pane(id: string, enabled: string[], preferred?: string): PaneSnapshot {
  return { id, enabled_modes: enabled, ...(preferred !== undefined ? { preferred_mode: preferred } : {}) } as PaneSnapshot;
}
function snap(p: PaneSnapshot): WorkspaceSnapshot {
  return {
    active_tab_id: 't', active_pane_id: p.id,
    tabs: [{ id: 't', title: 't', active_pane_id: p.id, lanes: [{ id: 'l', flex: 1, active_pane_id: p.id, pane_groups: [{ id: 'g', active_pane_id: p.id, panes: [p] }] }] }],
  } as WorkspaceSnapshot;
}
const mode = (id: string) => useStore.getState().getInputMode(id);

describe('preferred_mode (N1)', () => {
  it('an attaching app opens the pane on its preferred, enabled mode', () => {
    useStore.getState().setSnapshot(snap(pane('n1-a', ['shell', 'company'], 'company')));
    expect(mode('n1-a')).toBe('company');
  });
  it('applied once: a later snapshot does not pull the user back after they switch', () => {
    useStore.getState().setSnapshot(snap(pane('n1-b', ['shell', 'company'], 'company')));
    useStore.getState().setInputMode('n1-b', 'shell');
    useStore.getState().setSnapshot(snap(pane('n1-b', ['shell', 'company'], 'company')));
    expect(mode('n1-b')).toBe('shell');
  });
  it('a mode the pane does not have enabled is never applied', () => {
    useStore.getState().setSnapshot(snap(pane('n1-c', ['shell'], 'company')));
    expect(mode('n1-c')).toBe('shell');
  });
  it('a user pick made before the preference arrives wins', () => {
    useStore.getState().setInputMode('n1-d', 'prompt');
    useStore.getState().setSnapshot(snap(pane('n1-d', ['shell', 'prompt', 'company'], 'company')));
    expect(mode('n1-d')).toBe('prompt');
  });
  it('absent or empty preferred_mode changes nothing', () => {
    useStore.getState().setSnapshot(snap(pane('n1-e', ['shell', 'company'])));
    useStore.getState().setSnapshot(snap(pane('n1-f', ['shell', 'company'], '')));
    expect(mode('n1-e')).toBe('shell');
    expect(mode('n1-f')).toBe('shell');
  });
});
