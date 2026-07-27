// ANSI-to-HTML converter supporting SGR codes, 16/256/truecolor

// 16-color palette tuned for the app's dark background (#1e1e1e) — VS Code
// dark-terminal derived, NOT the raw VGA palette: VGA's blue (#0000aa) made
// `ls` directory names (SGR 34) unreadable on black. Blues are lifted extra
// (#3b8eea / #6cb6ff) since directory listings are the most common colored
// output. Black stays true black: it only appears intentionally, as fg on a
// colored bg (e.g. LS_COLORS setuid highlights).
const ANSI_COLORS_16 = [
  '#000000', '#e06c75', '#23d18b', '#e5c07b', '#3b8eea', '#d670d6', '#29b8db', '#d4d4d4',
  '#7f848e', '#f14c4c', '#3ee68b', '#f5f543', '#6cb6ff', '#ff8ae0', '#56d6f0', '#ffffff',
];

function xterm256ToHex(n: number): string {
  if (n < 16) return ANSI_COLORS_16[n];
  if (n < 232) {
    n -= 16;
    const r = Math.floor(n / 36) * 51;
    const g = Math.floor((n % 36) / 6) * 51;
    const b = (n % 6) * 51;
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
  }
  const v = 8 + (n - 232) * 10;
  return '#' + [v, v, v].map(c => c.toString(16).padStart(2, '0')).join('');
}

export function ansiToHtml(text: string): string {
  if (!text) return '';
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let result = '';
  let fg: string | null = null;
  let bg: string | null = null;
  let bold = false, dim = false, italic = false, underline = false, reverse = false, strikethrough = false;
  let openSpan = false;

  function emitSpan() {
    if (openSpan) { result += '</span>'; openSpan = false; }
    const styles: string[] = [];
    const classes: string[] = [];
    let eFg = fg, eBg = bg;
    if (reverse) { [eFg, eBg] = [eBg || '#1e1e1e', eFg || '#d4d4d4']; }
    if (eFg) styles.push('color:' + eFg);
    if (eBg) styles.push('background:' + eBg);
    if (bold) classes.push('ansi-bold');
    if (dim) classes.push('ansi-dim');
    if (italic) classes.push('ansi-italic');
    if (underline) classes.push('ansi-underline');
    if (strikethrough) classes.push('ansi-strikethrough');

    if (styles.length || classes.length) {
      result += '<span';
      if (classes.length) result += ' class="' + classes.join(' ') + '"';
      if (styles.length) result += ' style="' + styles.join(';') + '"';
      result += '>';
      openSpan = true;
    }
  }

  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      result += html.substring(lastIndex, match.index);
    }
    lastIndex = match.index + match[0].length;

    const params = match[1] ? match[1].split(';').map(Number) : [0];
    let i = 0;
    while (i < params.length) {
      const p = params[i];
      if (p === 0) {
        if (openSpan) { result += '</span>'; openSpan = false; }
        fg = bg = null; bold = dim = italic = underline = reverse = strikethrough = false;
      } else if (p === 1) { bold = true; emitSpan(); }
      else if (p === 2) { dim = true; emitSpan(); }
      else if (p === 3) { italic = true; emitSpan(); }
      else if (p === 4) { underline = true; emitSpan(); }
      else if (p === 7) { reverse = true; emitSpan(); }
      else if (p === 9) { strikethrough = true; emitSpan(); }
      else if (p === 22) { bold = false; dim = false; emitSpan(); }
      else if (p === 23) { italic = false; emitSpan(); }
      else if (p === 24) { underline = false; emitSpan(); }
      else if (p === 27) { reverse = false; emitSpan(); }
      else if (p === 29) { strikethrough = false; emitSpan(); }
      else if (p >= 30 && p <= 37) { fg = ANSI_COLORS_16[p - 30]; emitSpan(); }
      else if (p === 38) {
        if (params[i + 1] === 5 && i + 2 < params.length) { fg = xterm256ToHex(params[i + 2]); i += 2; emitSpan(); }
        else if (params[i + 1] === 2 && i + 4 < params.length) {
          fg = '#' + [params[i + 2], params[i + 3], params[i + 4]].map(c => c.toString(16).padStart(2, '0')).join('');
          i += 4; emitSpan();
        }
      }
      else if (p === 39) { fg = null; emitSpan(); }
      else if (p >= 40 && p <= 47) { bg = ANSI_COLORS_16[p - 40]; emitSpan(); }
      else if (p === 48) {
        if (params[i + 1] === 5 && i + 2 < params.length) { bg = xterm256ToHex(params[i + 2]); i += 2; emitSpan(); }
        else if (params[i + 1] === 2 && i + 4 < params.length) {
          bg = '#' + [params[i + 2], params[i + 3], params[i + 4]].map(c => c.toString(16).padStart(2, '0')).join('');
          i += 4; emitSpan();
        }
      }
      else if (p === 49) { bg = null; emitSpan(); }
      else if (p >= 90 && p <= 97) { fg = ANSI_COLORS_16[p - 90 + 8]; emitSpan(); }
      else if (p >= 100 && p <= 107) { bg = ANSI_COLORS_16[p - 100 + 8]; emitSpan(); }
      i++;
    }
  }

  if (lastIndex < html.length) {
    result += html.substring(lastIndex);
  }
  if (openSpan) result += '</span>';

  // Strip unhandled escape sequences.
  result = result.replace(/\x1b\[[0-9;]*[A-HJKSTfhln]/g, '');
  result = result.replace(/\x1b\][^\x07]*\x07/g, '');
  result = result.replace(/\x1b\[[?][0-9;]*[hlr]/g, '');
  result = result.replace(/\x1b[()][012AB]/g, '');
  result = result.replace(/\x1b=/g, '');
  result = result.replace(/\r/g, '');

  return result;
}

/**
 * Apply carriage-return (\r) semantics within a single line of terminal output.
 *
 * A carriage return moves the cursor back to column 0, so text emitted after it
 * overwrites the text before it on the same line (the longer side's tail
 * survives). bash redraws its prompt on every SIGWINCH/resize by emitting
 * "\r<prompt>", and a freshly-opened pane receives a few resize events as its
 * layout settles. Without honouring the carriage return those redraws used to be
 * stripped and concatenated, rendering as
 *   "bash-3.2$ bash-3.2$ bash-3.2$ bash-3.2$ ..."
 * all on one line. Overlaying collapses the identical redraws back to a single
 * visible prompt, and renders progress-bar / spinner "\r" updates as their final
 * state instead of a run of concatenated frames.
 *
 * Operates on raw characters; SGR/escape bytes are treated as plain characters
 * here (prompts and progress bars rarely embed colour mid-line, and ansiToHtml
 * runs afterwards and tolerates/strips any stray escapes), which keeps this cheap
 * and dependency-free.
 */
function collapseCarriageReturns(line: string): string {
  if (line.indexOf('\r') === -1) return line;
  let buf = '';
  for (const seg of line.split('\r')) {
    // Each segment is written starting at column 0, overwriting what's there.
    buf = seg.length >= buf.length ? seg : seg + buf.slice(seg.length);
  }
  return buf;
}

/**
 * Build output HTML from raw terminal text.
 * Lines starting with \x02 are right-aligned prompt echo lines.
 */
export function buildOutputHtml(outText: string): string {
  const lines = outText.split('\n');
  const processedLines = lines.map(rawLine => {
    const line = collapseCarriageReturns(rawLine);
    if (line.startsWith('\x02')) {
      return '<div style="text-align:right;color:#5fafff;font-weight:bold">' + ansiToHtml(line.substring(1)) + '</div>';
    }
    return ansiToHtml(line);
  });
  return processedLines.join('\n');
}
