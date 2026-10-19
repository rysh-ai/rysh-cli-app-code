import { describe, expect, it } from 'vitest';
import { countViews, filterThreads, isPromptThread } from './views';
import type { BoardPost, BoardThread } from '../types';

const p = (kind: string): BoardPost => ({ pane_id: 'a', persona: 'a', kind, text: '', ts: 1 });
const t = (key: string, root: BoardPost | null, replies: BoardPost[] = []): BoardThread => ({
  key,
  root,
  replies,
  provisional: !root,
});

describe('board views (design 051)', () => {
  const status = t('s', p('milestone'), [p('reply')]);
  const prompt = t('p', p('cmd'), [p('ack')]);
  const provisional = t('v', null, [p('ack')]);

  it('a thread is a prompt thread by its root, or by what a provisional one holds', () => {
    expect(isPromptThread(status)).toBe(false);
    expect(isPromptThread(prompt)).toBe(true);
    expect(isPromptThread(provisional)).toBe(true);
  });

  it('filters whole threads and counts both views', () => {
    const all = [status, prompt, provisional];
    expect(filterThreads(all, 'status')).toEqual([status]);
    expect(filterThreads(all, 'prompt')).toEqual([prompt, provisional]);
    expect(filterThreads(all, 'all')).toEqual(all);
    expect(countViews(all)).toEqual({ status: 1, prompt: 2 });
  });
});
