import { describe, expect, it } from 'vitest';
import {
  boardPersona,
  buildCopy,
  copySummary,
  flattenBoard,
  formatItems,
  itemClock,
  outputFileName,
  renderBoardHTML,
  sanitiseBody,
  sanitiseInline,
  statusTone,
} from './items';
import type { BoardPost, BoardThread } from '../types';

// A port of rysh-cli internal/board/items.go + html.go. The property under
// test is that the desktop app's copy of a board is the SAME TEXT `##board
// copy` and the TUI's y / Y produce — so these cases mirror items_test.go.

const post = (over: Partial<BoardPost>): BoardPost => ({
  pane_id: 'aaaaaaaa-1111-2222-3333-444444444444',
  persona: 'worker-1',
  kind: 'milestone',
  text: 'hello',
  ts: 1000,
  ...over,
});

describe('flattenBoard', () => {
  it('orders roots and replies by the poster clock, oldest first', () => {
    const threads: BoardThread[] = [
      {
        key: 't1',
        root: post({ text: 'root-1', ts: 30 }),
        replies: [post({ text: 'reply-1', ts: 10, kind: 'reply' })],
        provisional: false,
      },
      { key: 't2', root: post({ text: 'root-2', ts: 20 }), replies: null, provisional: false },
    ];
    const items = flattenBoard({ threads });
    expect(items.map((i) => i.post.text)).toEqual(['reply-1', 'root-2', 'root-1']);
    expect(items[0].reply).toBe(true);
    expect(items[0].threadKey).toBe('t1');
  });

  it('never scrubs the live board in place', () => {
    const root = post({ text: 'a\x1b[31mred\x1b[0m' });
    flattenBoard({ threads: [{ key: 't', root, replies: [], provisional: false }] });
    expect(root.text).toBe('a\x1b[31mred\x1b[0m');
  });

  it('keep filters on the original post', () => {
    const a = post({ text: 'a', ts: 1 });
    const b = post({ text: 'b', ts: 2 });
    const items = flattenBoard(
      { threads: [{ key: 't', root: a, replies: [b], provisional: false }] },
      (p) => p === b
    );
    expect(items.map((i) => i.post.text)).toEqual(['b']);
  });
});

describe('sanitising', () => {
  it('removes whole escape sequences, keeps newlines and tabs', () => {
    expect(sanitiseBody('a\x1b[31mred\x1b[0m\tx\r\ny\rz')).toBe('ared\tx\ny\nz');
    expect(sanitiseBody('t\x1b]0;title\x07end')).toBe('tend');
    expect(sanitiseBody('k\x1b]8;;http://x\x1b\\link')).toBe('klink');
    expect(sanitiseBody('del\x7f c1\u0085')).toBe('del c1');
  });

  it('flattens a one-line value', () => {
    expect(sanitiseInline('a\nb\tc')).toBe('a b c');
  });
});

describe('formatItems', () => {
  it('is the ##board copy text: header, unwrapped body, blank line between, no trailing newline', () => {
    const long = 'https://example.com/' + 'x'.repeat(200);
    const items = flattenBoard({
      threads: [
        {
          key: 't',
          root: post({ text: 'line1\nline2', ts: 1 }),
          replies: [post({ persona: '', kind: 'reply', text: long, ts: 2 })],
          provisional: false,
        },
      ],
    });
    const text = formatItems(items);
    expect(text).toBe(
      `● worker-1  [milestone]  ${itemClock(1)}\nline1\nline2\n\n` +
        `● pane-aaaaaaaa  [reply]  ${itemClock(2)}\n${long}`
    );
  });

  it('falls back like msg.BoardPersona, never printing an approval pane subject', () => {
    expect(boardPersona('req\x1fsubject', 'abcdefgh-123')).toBe('pane-abcdefgh');
    expect(boardPersona('', '')).toBe('pane-unknown');
  });
});

describe('buildCopy', () => {
  const items = flattenBoard({
    threads: [
      { key: 't', root: post({ text: 'one', ts: 1 }), replies: [post({ text: 'two', ts: 2 })], provisional: false },
    ],
  });

  it('y takes the newest message', () => {
    const r = buildCopy(items, 1);
    expect(r.text.endsWith('\ntwo')).toBe(true);
    expect(r.text).not.toContain('\none');
    expect(copySummary(r)).toBe('[board] copied 1 of 2 messages to the clipboard');
  });

  it('refuses rather than copying nothing', () => {
    expect(() => buildCopy([], 0)).toThrow('[board] no messages');
  });

  it('refuses a copy over the clipboard limit rather than cutting it', () => {
    const big = flattenBoard({
      threads: [{ key: 't', root: post({ text: 'x'.repeat(300 * 1024) }), replies: [], provisional: false }],
    });
    expect(() => buildCopy(big, 0)).toThrow(/over the 256 KiB clipboard limit/);
  });
});

describe('renderBoardHTML', () => {
  it('escapes agent-written text and links URLs', () => {
    const items = flattenBoard({
      threads: [
        {
          key: 't',
          root: post({ persona: '<b>x</b>', text: 'see https://example.com/a?b=1&c=2.\n<script>alert(1)</script>' }),
          replies: [],
          provisional: false,
        },
      ],
    });
    const html = renderBoardHTML({ board: 'fleet', picked: items, total: 1, now: new Date(0) });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">');
    expect(html).toContain('<title>Agent board · fleet</title>');
  });

  it('turns FIELD: lines into a grid with a STATUS badge', () => {
    const items = flattenBoard({
      threads: [
        {
          key: 't',
          root: post({ text: 'intro\nSTATUS: blocked - waiting on review\nNEXT: merge\n  more' }),
          replies: [],
          provisional: false,
        },
      ],
    });
    const html = renderBoardHTML({ board: 'b', picked: items, total: 1, now: new Date(0) });
    expect(html).toContain('<p class="loose">intro</p>');
    expect(html).toContain('<span class="badge bad">blocked</span>');
    expect(html).toContain('<dt>NEXT</dt><dd>merge\n  more</dd>');
  });

  it('tones STATUS values like html.go', () => {
    expect(statusTone('In progress')).toBe('info');
    expect(statusTone('done')).toBe('good');
    expect(statusTone('whatever')).toBe('muted');
  });
});

it('outputFileName matches board.OutputFileName', () => {
  const now = new Date(2026, 9, 11, 9, 5, 7);
  expect(outputFileName('fleet/x y', now)).toBe('board-fleet_x_y-20261011-090507.html');
});
