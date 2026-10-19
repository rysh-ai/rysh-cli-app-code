// One owner for the monospace cell size of the VT screen (design 018 §5
// gap 5). Three consumers depend on it and must agree:
//   - usePaneResize: PTY rows/cols from the pane's content box;
//   - VTScreen: the cursor-follow scroll offset;
//   - PaneBox's wheel/touch-drag forwarding: pixel deltas → cell rows.
// They used to compute it three ways, two of them hardcoding 13px × 1.2, so
// a font change in .vt-screen (index.css) would size the PTY for one grid
// and scroll by another.
//
// The font SIZE comes from the .vt-screen CSS, read through computed style;
// the constants below mirror index.css and are the fallback when no
// stylesheet applies (tests, or before CSS has loaded).

/** .vt-screen font-size in index.css. */
export const VT_FONT_SIZE_PX = 13;
/** .vt-screen line-height (and .vt-line height: 1.2em). */
export const VT_LINE_HEIGHT = 1.2;
/** The app's mono font stack (html/body in index.css; .vt-screen inherits it). */
export const VT_FONT_FAMILY =
  '"JetBrains Mono","Fira Code","Cascadia Code","SF Mono","Menlo","Monaco","Consolas",monospace';
/** Cell width when measuring yields nothing (fonts not ready, no layout). */
export const CELL_W_FALLBACK = 7.8;

export interface CellSize {
  w: number;
  h: number;
}

function fontSizeOf(cs: CSSStyleDeclaration): number {
  return parseFloat(cs.fontSize) || VT_FONT_SIZE_PX;
}

/** Cell height for a font size: one .vt-line (font-size × line-height). */
export function cellHeightForFontSize(fontSizePx: number): number {
  return fontSizePx * VT_LINE_HEIGHT;
}

/** Cell height of a rendered .vt-screen element, from its computed font. */
export function cellHeightOf(vtEl: Element): number {
  return cellHeightForFontSize(fontSizeOf(window.getComputedStyle(vtEl)));
}

// DOM-probe measurement for a .vt-screen that may not exist yet (the resize
// hook sizes the PTY for panes not showing a VT screen). The probe carries
// the .vt-screen class so the real CSS font size applies, with layout
// overrides so only the glyph run is measured. Cached per font size.
const probeCache = new Map<number, CellSize>();
export function measureVTCell(): CellSize {
  const probe = document.createElement('span');
  probe.className = 'vt-screen';
  probe.style.cssText =
    'position:absolute;visibility:hidden;white-space:pre;padding:0;flex:none;' +
    `line-height:${VT_LINE_HEIGHT};font-family:${VT_FONT_FAMILY};`;
  probe.textContent = 'M'.repeat(100);
  document.body.appendChild(probe);
  try {
    const size = fontSizeOf(window.getComputedStyle(probe));
    const cached = probeCache.get(size);
    if (cached) return cached;
    const w = probe.getBoundingClientRect().width / 100;
    const cell = { w: w > 0 ? w : CELL_W_FALLBACK, h: cellHeightForFontSize(size) };
    // A fallback width is not cached: fonts may not have loaded yet.
    if (w > 0) probeCache.set(size, cell);
    return cell;
  } finally {
    document.body.removeChild(probe);
  }
}

// Canvas measurement of a rendered element's own computed font (the wheel
// path, which always has the .vt-screen in hand). Cached per font string.
let canvasCache: (CellSize & { font: string }) | null = null;
export function measureCellOf(vtEl: Element): CellSize {
  const cs = window.getComputedStyle(vtEl);
  const font = `${cs.fontSize} ${cs.fontFamily}`;
  if (canvasCache && canvasCache.font === font) return canvasCache;
  let w = CELL_W_FALLBACK;
  const ctx = document.createElement('canvas').getContext('2d');
  if (ctx) {
    ctx.font = font;
    const m = ctx.measureText('M').width;
    if (m > 0) w = m;
  }
  canvasCache = { w, h: cellHeightForFontSize(fontSizeOf(cs)), font };
  return canvasCache;
}
