import { describe, expect, it } from 'vitest';
import { clipboardSourceFor } from './clipboard';

describe('clipboardSourceFor', () => {
  // A board pane is shell-less; its `output` holds stale text, never the board.
  it('asks for the board on an agents-board pane (design 049)', () => {
    expect(clipboardSourceFor({ pane_type: 'agents-board' }, 'shell')).toBe('board');
  });

  it('keeps the buffer the screen shows on every other pane', () => {
    expect(clipboardSourceFor({}, 'prompt')).toBe('ai_output');
    expect(clipboardSourceFor({}, 'shell')).toBe('output');
  });
});
