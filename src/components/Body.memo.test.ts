import { describe, it, expect } from 'vitest';
import { memoPaneRender } from './Body';
import type { PaneSnapshot } from '../types';

// Body re-renders on output from any pane in the session. It used to rebuild
// every pane's props each time, defeating PaneBox's React.memo, so every
// visible pane re-rendered and re-parsed its output on every chunk from
// anywhere. memoPaneRender hands back the same props object until one of the
// values it was built from changes.
describe('memoPaneRender', () => {
  const pane = { id: 'p' } as PaneSnapshot;

  it('returns the identical props while the inputs are unchanged', () => {
    const cache = new Map();
    const content = { output: 'x' };
    let builds = 0;
    const build = () => { builds++; return { pane: { ...pane } }; };
    const first = memoPaneRender(cache, 'p', [pane, content, 'shell'], build);
    const second = memoPaneRender(cache, 'p', [pane, content, 'shell'], build);
    expect(second).toBe(first);
    expect(builds).toBe(1);
  });

  it('rebuilds when any input changes', () => {
    const cache = new Map();
    const a = memoPaneRender(cache, 'p', [pane, { output: 'x' }, 'shell'], () => ({ pane: { ...pane } }));
    const b = memoPaneRender(cache, 'p', [pane, { output: 'x' }, 'shell'], () => ({ pane: { ...pane } }));
    expect(b).not.toBe(a); // a new content object is new output
    const c = memoPaneRender(cache, 'p', [pane, undefined, 'prompt'], () => ({ pane: { ...pane } }));
    expect(c).not.toBe(b);
  });
});
