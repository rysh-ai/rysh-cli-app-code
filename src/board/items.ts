import type { BoardData, BoardPost } from '../types';

// Getting messages OUT of the board — the app's half of `##board copy`,
// `##board output` and the TUI board pane's y / Y / o keys (design 049).
//
// A PORT, NOT A REDESIGN. rysh-cli/internal/board/items.go is the one item
// model every surface uses (`##board copy`, `rysh board copy|output`, the TUI
// pane, the web client's clipboard_copy of a board pane), and html.go its
// shareable page. This file mirrors both so that "copy the newest message" in
// the desktop app produces byte for byte what `y` in the terminal does. Change
// one, change the other.
//
// THE TEXT IS UNWRAPPED. A body comes out as posted, less only the terminal
// escape sequences sanitiseBody strips — posts are written by agents, and an
// escape pasted into a terminal is live.

/** board.CopyMaxBytes — the largest clipboard copy any surface makes. */
export const COPY_MAX_BYTES = 256 * 1024;

/** One agent message: a thread's root post or one of its replies. */
export interface BoardItem {
  post: BoardPost; // a sanitised copy
  threadKey: string;
  reply: boolean;
}

/** msg.BoardPersona(givenName, "", paneID): the one way a post becomes a name. */
export function boardPersona(persona: string, paneId: string): string {
  if (persona && !persona.includes('\x1f')) return persona;
  if (paneId.length >= 8) return 'pane-' + paneId.slice(0, 8);
  if (paneId) return 'pane-' + paneId;
  return 'pane-unknown';
}

/**
 * Flatten turns a board answer into items, oldest first by the poster's clock
 * (ties keep the board's arrival order). `keep` filters on the ORIGINAL post.
 */
export function flattenBoard(
  data: Pick<BoardData, 'threads'> | undefined,
  keep?: (p: BoardPost) => boolean
): BoardItem[] {
  const items: BoardItem[] = [];
  for (const t of data?.threads || []) {
    if (t.root && (!keep || keep(t.root))) {
      items.push({ post: sanitisedPost(t.root), threadKey: t.key, reply: false });
    }
    for (const r of t.replies || []) {
      if (r && (!keep || keep(r))) items.push({ post: sanitisedPost(r), threadKey: t.key, reply: true });
    }
  }
  // Array.prototype.sort is stable, as sort.SliceStable is.
  return items.sort((a, b) => a.post.ts - b.post.ts);
}

/**
 * The clipboard text: per item a header line and the raw body, a blank line
 * between items, no trailing newline (a stray newline pasted into a shell runs
 * whatever came before it).
 *
 *   ● <persona>  [<kind>]  <YYYY-MM-DD HH:MM:SS>
 *   <original post text>
 */
export function formatItems(items: BoardItem[]): string {
  return items
    .map(({ post: p }) => {
      let head = '● ' + sanitiseInline(boardPersona(p.persona, p.pane_id));
      const k = sanitiseInline(p.kind);
      if (k) head += '  [' + k + ']';
      head += '  ' + itemClock(p.ts);
      return head + '\n' + sanitiseBody(p.text);
    })
    .join('\n\n');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The full local date-time of a post, the poster's clock. */
export function itemClock(ts: number): string {
  if (!ts || ts <= 0) return '----------- --:--:--';
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export interface CopyResult {
  text: string;
  picked: number;
  total: number;
}

/**
 * BuildCopyItems: the last n items (0 = all), formatted. Throws with the
 * refusal line the TUI flashes — nothing to copy is a refusal, never an empty
 * clipboard, and an oversized copy is refused rather than cut.
 */
export function buildCopy(items: BoardItem[], n: number): CopyResult {
  const picked = n > 0 && n < items.length ? items.slice(items.length - n) : items;
  if (picked.length === 0) throw new Error('[board] no messages');
  const text = formatItems(picked);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > COPY_MAX_BYTES) {
    throw new Error(
      `[board] copy refused: ${bytes} bytes is over the ${COPY_MAX_BYTES / 1024} KiB clipboard limit — ` +
        'copy fewer messages'
    );
  }
  return { text, picked: picked.length, total: items.length };
}

/** CopyResult.Summary, the confirmation every copy surface prints. */
export function copySummary(r: CopyResult): string {
  return `[board] copied ${r.picked} of ${r.total} messages to the clipboard`;
}

// ── Sanitising agent-written text (items.go SanitiseBody / SanitiseInline) ──

/**
 * Safe to copy, print or render, otherwise byte for byte: newlines and tabs
 * stay, CRLF and lone CR become LF, and every terminal escape sequence is
 * removed WHOLE — not just its ESC byte — along with other C0/C1 controls and DEL.
 */
export function sanitiseBody(s: string): string {
  return stripControls((s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), true);
}

/** sanitiseBody for a one-line value (persona, kind). */
export function sanitiseInline(s: string): string {
  return stripControls((s || '').replace(/\r\n|[\r\n\t]/g, ' '), false);
}

function stripControls(s: string, keepLayout: boolean): string {
  const rs = Array.from(s).map((c) => c.codePointAt(0)!);
  let out = '';
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i];
    if (r === 0x1b) {
      i = skipEscape(rs, i);
    } else if (r === 0x9b) {
      i = skipCSI(rs, i + 1);
    } else if (r === 0x9d || r === 0x90 || r === 0x98 || r === 0x9e || r === 0x9f) {
      i = skipString(rs, i + 1);
    } else if (keepLayout && (r === 0x0a || r === 0x09)) {
      out += String.fromCodePoint(r);
    } else if (r < 0x20 || r === 0x7f || (r >= 0x80 && r < 0xa0)) {
      // dropped
    } else {
      out += String.fromCodePoint(r);
    }
  }
  return out;
}

function skipEscape(rs: number[], i: number): number {
  if (i + 1 >= rs.length) return i;
  switch (rs[i + 1]) {
    case 0x5b: // [
      return skipCSI(rs, i + 2);
    case 0x5d: // ]
    case 0x50: // P
    case 0x58: // X
    case 0x5e: // ^
    case 0x5f: // _
      return skipString(rs, i + 2);
  }
  // Two-byte escapes: intermediates 0x20–0x2f then one final byte.
  let j = i + 1;
  while (j < rs.length && rs[j] >= 0x20 && rs[j] <= 0x2f) j++;
  if (j >= rs.length) return rs.length - 1;
  return j;
}

function skipCSI(rs: number[], j: number): number {
  for (; j < rs.length; j++) {
    if (rs[j] >= 0x40 && rs[j] <= 0x7e) return j;
    if (rs[j] < 0x20) return j - 1; // malformed: let the caller handle the control
  }
  return rs.length - 1;
}

function skipString(rs: number[], j: number): number {
  for (; j < rs.length; j++) {
    if (rs[j] === 0x07 || rs[j] === 0x9c) return j;
    if (rs[j] === 0x1b) {
      if (j + 1 < rs.length && rs[j + 1] === 0x5c) return j + 1;
      return j - 1; // cut short by a new escape
    }
  }
  return rs.length - 1;
}

function sanitisedPost(p: BoardPost): BoardPost {
  return { ...p, text: sanitiseBody(p.text), persona: sanitiseInline(p.persona), kind: sanitiseInline(p.kind) };
}

// ── The shareable page (html.go RenderHTML) ──

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:]/g;
const FIELD_RE = /^\s*([A-Z][A-Z /&-]{1,30}):\s?(.*)$/;

const STATUS_TONES: Array<[string, string]> = [
  ['blocked', 'bad'],
  ['waiting', 'warn'],
  ['progress', 'info'],
  ['done', 'good'],
  ['idle', 'muted'],
  ['milestone', 'good'],
];

/** The badge class for a STATUS value, first match wins. */
export function statusTone(value: string): string {
  const v = value.toLowerCase();
  for (const [key, tone] of STATUS_TONES) if (v.includes(key)) return tone;
  return 'muted';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' })[c]!);
}

/** Text with its URLs as links. Escaped first: post text is agent-written. */
function linkify(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    const at = m.index!;
    out += esc(s.slice(last, at)) + `<a href="${esc(m[0])}">${esc(m[0])}</a>`;
    last = at + m[0].length;
  }
  return out + esc(s.slice(last));
}

function parseFields(text: string): { loose: string; fields: Array<[string, string]>; status: string } {
  const rows: Array<[string, string]> = [];
  const pre: string[] = [];
  let status = '';
  for (const line of text.split('\n')) {
    const m = FIELD_RE.exec(line);
    if (m) {
      const label = m[1].trim();
      if (label === 'STATUS' && !status) status = m[2];
      rows.push([label, m[2]]);
    } else if (rows.length > 0) {
      rows[rows.length - 1][1] += '\n' + line;
    } else {
      pre.push(line);
    }
  }
  return { loose: pre.join('\n').trim(), fields: rows.map(([l, v]) => [l, v.trim()]), status };
}

function badgeText(status: string): string {
  const head = status.split(' - ')[0];
  return Array.from(head).slice(0, 40).join('');
}

export interface HTMLPage {
  board: string;
  picked: BoardItem[]; // oldest first
  total: number; // every item on the board window
  now: Date;
}

/** RenderHTML: one standalone page, no external assets. */
export function renderBoardHTML(p: HTMLPage): string {
  const cards = p.picked.map(({ post }) => {
    const when = itemClock(post.ts);
    const { loose, fields, status } = parseFields(sanitiseBody(post.text));
    const persona = sanitiseInline(post.persona) || '?';
    const badge = status ? `<span class="badge ${statusTone(status)}">${esc(badgeText(status))}</span>` : '';
    return `
<article class="card">
  <header>
    <span class="persona">${esc(persona)}</span>
    <span class="kind">${esc(sanitiseInline(post.kind))}</span>
    ${badge}
    <time datetime="${when.replace(' ', 'T')}">${when}</time>
  </header>
  ${loose ? `<p class="loose">${linkify(loose)}</p>` : ''}
  ${fields.length ? `<dl>${fields.map(([l, v]) => `<dt>${esc(l)}</dt><dd>${linkify(v)}</dd>`).join('')}</dl>` : ''}
</article>`;
  });
  const title = 'Agent board · ' + p.board;
  const meta = `${p.picked.length} messages · board has ${p.total} messages · generated ${itemClock(p.now.getTime()).slice(0, 16)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p class="meta">${esc(meta)}</p>
${cards.join('\n')}
</main></body></html>
`;
}

/** board.OutputFileName for an unfiltered window. */
export function outputFileName(board: string, now: Date): string {
  const safe = Array.from(board)
    .map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : '_'))
    .join('') || '_';
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `board-${safe}-${stamp}.html`;
}

// Kept identical to html.go's stylesheet so the two pages look the same.
const PAGE_CSS = `
:root {
  --bg:#f6f7f9; --card:#ffffff; --fg:#1d232b; --muted:#5d6875; --line:#e1e5ea; --link:#1f5fbf;
  --good:#1f7a4d; --good-bg:#e3f4ea; --bad:#b3261e; --bad-bg:#fbe7e5; --warn:#8a5a00; --warn-bg:#fdf1d6;
  --info:#1f5fbf; --info-bg:#e5eefb; --mut:#5d6875; --mut-bg:#eceff3;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#12161b; --card:#1a2027; --fg:#e4e8ed; --muted:#98a3b0; --line:#2a323c; --link:#8ab4f8;
  --good:#7fd6a4; --good-bg:#16352a; --bad:#f2a49c; --bad-bg:#3d1c1a; --warn:#f0c674; --warn-bg:#3a2e14;
  --info:#8ab4f8; --info-bg:#172a45; --mut:#98a3b0; --mut-bg:#232a33; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width:960px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:20px; margin:0 0 4px; }
.meta { color:var(--muted); margin:0 0 20px; font-size:13px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px;
  margin:0 0 12px; break-inside:avoid; page-break-inside:avoid; }
.card header { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:8px; }
.persona { font-weight:600; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
.kind { color:var(--muted); font-size:12px; }
time { margin-left:auto; color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
.badge { font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; text-transform:uppercase; letter-spacing:.02em; }
.good { color:var(--good); background:var(--good-bg); } .bad { color:var(--bad); background:var(--bad-bg); }
.warn { color:var(--warn); background:var(--warn-bg); } .info { color:var(--info); background:var(--info-bg); }
.muted { color:var(--mut); background:var(--mut-bg); }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 14px; margin:0; }
dt { font-weight:600; font-size:12px; color:var(--muted); padding-top:1px; white-space:nowrap; }
dd { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
.loose { margin:0 0 6px; white-space:pre-wrap; overflow-wrap:anywhere; }
a { color:var(--link); text-decoration:none; } a:hover { text-decoration:underline; }
@media (max-width:600px) { dl { grid-template-columns:1fr; } dt { margin-top:6px; } }
@media print {
  :root, :root:not([data-theme="light"]) {
    --bg:#ffffff; --card:#ffffff; --fg:#1d232b; --muted:#5d6875; --line:#cccccc; --link:#1f5fbf;
    --good:#1f7a4d; --good-bg:#e3f4ea; --bad:#b3261e; --bad-bg:#fbe7e5; --warn:#8a5a00; --warn-bg:#fdf1d6;
    --info:#1f5fbf; --info-bg:#e5eefb; --mut:#5d6875; --mut-bg:#eceff3; }
  body { background:#fff; } main { padding:0; max-width:none; } }
`;
