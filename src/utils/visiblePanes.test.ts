import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const sent: { action: string; params?: Record<string, unknown> }[] = [];
vi.mock('./commands', () => ({
  sendCommand: (action: string, params?: Record<string, unknown>) => sent.push({ action, params }),
}));

import {
  retainVisiblePane,
  releaseVisiblePane,
  resendVisiblePanes,
  _resetVisiblePanesForTest,
} from './visiblePanes';

const idsSent = () => sent.map((c) => c.params?.pane_ids);

describe('visiblePanes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    _resetVisiblePanesForTest();
  });
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst of mounts into one sorted visible_panes command', () => {
    retainVisiblePane('b');
    retainVisiblePane('a');
    expect(sent).toHaveLength(0);
    vi.runAllTimers();
    expect(sent).toEqual([{ action: 'visible_panes', params: { pane_ids: ['a', 'b'] } }]);
  });

  it('keeps a pane visible while any renderer still holds it, and skips no-op updates', () => {
    retainVisiblePane('a');
    retainVisiblePane('a'); // e.g. fullscreen swap mounts the new box before the old unmounts
    vi.runAllTimers();
    releaseVisiblePane('a');
    vi.runAllTimers();
    expect(idsSent()).toEqual([['a']]);
    releaseVisiblePane('a');
    vi.runAllTimers();
    expect(idsSent()).toEqual([['a'], []]);
  });

  it('resends the unchanged set after a reconnect', () => {
    retainVisiblePane('a');
    vi.runAllTimers();
    resendVisiblePanes();
    expect(idsSent()).toEqual([['a'], ['a']]);
  });
});
