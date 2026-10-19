import { describe, expect, it, vi, beforeEach } from 'vitest';

const sent: { action: string; params?: Record<string, unknown> }[] = [];
vi.mock('./commands', () => ({
  sendCommand: (action: string, params?: Record<string, unknown>) => sent.push({ action, params }),
}));

import { isWebSyncOff, resumeWebSync, PANE_META_WEB_SYNC } from './paneSync';

describe('paneSync', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('treats only an explicit "off" as paused, like the daemon', () => {
    expect(isWebSyncOff({})).toBe(false);
    expect(isWebSyncOff({ meta: {} })).toBe(false);
    expect(isWebSyncOff({ meta: { [PANE_META_WEB_SYNC]: 'on' } })).toBe(false);
    expect(isWebSyncOff({ meta: { [PANE_META_WEB_SYNC]: 'false' } })).toBe(false);
    expect(isWebSyncOff({ meta: { [PANE_META_WEB_SYNC]: 'off' } })).toBe(true);
    expect(isWebSyncOff({ meta: { [PANE_META_WEB_SYNC]: ' OFF ' } })).toBe(true);
  });

  it('resumes through a ## line pinned to the pane', () => {
    resumeWebSync('p1');
    expect(sent).toEqual([
      { action: 'submit_input', params: { text: '##pane sync on', mode: 'rysh', pane_id: 'p1' } },
    ]);
  });
});
