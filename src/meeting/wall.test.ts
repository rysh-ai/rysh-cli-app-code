import { describe, expect, it } from 'vitest';
import { formatElapsed, parseWall, wallDetail, WALL_LABELS } from './wall';

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('parseWall', () => {
  it('reads the 040 status message from bytes', () => {
    const s = parseWall(
      enc({ type: 'status', phase: 'thinking', state: 'executing', speaker: 'Ada', request: 'what changed', agent: 'docs', elapsed_ms: 1200 }),
    );
    expect(s).toEqual({ phase: 'thinking', speaker: 'Ada', request: 'what changed', agent: 'docs', elapsedMs: 1200 });
  });

  it('ignores anything that is not a status message', () => {
    expect(parseWall('not json')).toBeNull();
    expect(parseWall(enc({ type: 'audio', phase: 'speaking' }))).toBeNull();
    expect(parseWall(enc({ type: 'status' }))).toBeNull();
    expect(parseWall(enc(['status']))).toBeNull();
    expect(parseWall('x'.repeat(20000))).toBeNull();
  });

  it('maps unknown phases to working so a newer bot never breaks the panel', () => {
    expect(parseWall(enc({ type: 'status', phase: 'brand_new' }))?.phase).toBe('working');
  });

  it('keeps captions only while speaking and errors only on error', () => {
    expect(parseWall(enc({ type: 'status', phase: 'thinking', caption: 'x', error: 'y' }))).toEqual({ phase: 'thinking' });
    expect(parseWall(enc({ type: 'status', phase: 'speaking', caption: 'Hello.' }))?.caption).toBe('Hello.');
    expect(parseWall(enc({ type: 'status', phase: 'error', error: 'Too many turns' }))?.error).toBe('Too many turns');
  });

  it('strips control characters, clips long text and rejects bad timers', () => {
    const s = parseWall(enc({ type: 'status', phase: 'heard', speaker: 'A\u001b[31mda', request: 'q'.repeat(400), elapsed_ms: -5 }));
    expect(s?.speaker).toBe('A [31mda');
    expect(Array.from(s!.request!).length).toBe(160);
    expect(s?.request?.endsWith('…')).toBe(true);
    expect(s?.elapsedMs).toBeUndefined();
  });
});

describe('wallDetail', () => {
  it('prefers activity, then error, then the agent, then the hint', () => {
    expect(wallDetail({ phase: 'thinking', activity: 'reading notes.md', agent: 'scribe' })).toBe('reading notes.md');
    expect(wallDetail({ phase: 'error', error: 'Speech failed' })).toBe('Speech failed');
    expect(wallDetail({ phase: 'thinking', agent: 'scribe' })).toBe('Scribe is working on it');
    expect(wallDetail({ phase: 'speaking', agent: 'scribe' })).toBe('Scribe is answering');
    expect(wallDetail({ phase: 'listening' })).toBe(WALL_LABELS.listening[1]);
    expect(wallDetail({ phase: 'listening', agent: 'scribe' })).toBe('Say “hey scribe” and ask a question');
  });
});

it('formats elapsed time as m:ss', () => {
  expect(formatElapsed(0)).toBe('0:00');
  expect(formatElapsed(65_400)).toBe('1:05');
  expect(formatElapsed(-10)).toBe('0:00');
});
