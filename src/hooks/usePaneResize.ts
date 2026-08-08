import { useCallback, useEffect, useRef } from 'react';
import { sendCommand } from '../utils/commands';
import { useStore } from '../store';

/**
 * usePaneResize keeps a pane's PTY + virtual terminal sized to the actual
 * on-screen content area, measured in monospace character cells. Without it the
 * daemon's PTY stays at its 80x24 default, so interactive apps (vim, claude,
 * htop) only fill ~24 rows regardless of how tall the pane really is.
 *
 * What it sends is a size CLAIM, not a command. A pane has one PTY but can be
 * on screen in several viewports at once — another app window, or a terminal UI
 * attached to the same daemon — and the daemon sizes the PTY to the SMALLEST of
 * them, so the grid fits inside every viewport showing it. This window may
 * therefore end up rendering a grid smaller than its pane, with space around
 * it; that is the correct outcome, since the alternative is a smaller viewport
 * having to truncate a full-screen app's display.
 *
 * Returns a callback ref to attach to the pane's content container. The callback
 * ref (rather than a useEffect) is deliberate: a stacked pane's content node
 * mounts/unmounts as it expands/collapses, and fullscreen swaps the node — the
 * callback fires with the node on attach and null on detach, so the
 * ResizeObserver is wired up exactly when a measurable node exists.
 */

// Measured monospace cell size for the .vt-screen metrics (13px, line-height
// 1.2, app mono font stack). Cached after first measure — it only depends on the
// font, which doesn't change at runtime.
let cellW = 0;
let cellH = 0;
function measureCell(): { w: number; h: number } {
  if (cellW > 0 && cellH > 0) return { w: cellW, h: cellH };
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;visibility:hidden;white-space:pre;font-size:13px;line-height:1.2;' +
    'font-family:"JetBrains Mono","Fira Code","Cascadia Code","SF Mono","Menlo","Monaco","Consolas",monospace;';
  probe.textContent = 'M'.repeat(100);
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 100;
  document.body.removeChild(probe);
  cellW = w > 0 ? w : 7.8; // fallback if measured before fonts are ready
  cellH = 13 * 1.2; // font-size 13px × line-height 1.2 (see .vt-screen)
  return { w: cellW, h: cellH };
}

// The VT content has 2px/4px padding (.vt-screen) — subtract it so the computed
// grid matches what actually renders.
const PAD_X = 8; // 4px left + 4px right
const PAD_Y = 4; // 2px top + 2px bottom
const DEBOUNCE_MS = 80; // coalesce a window-drag burst into one resize

export function usePaneResize(paneId: string): (el: HTMLElement | null) => void {
  // Per-pane observer/timer/last-sent state, persisted across attach cycles so a
  // collapse→expand doesn't re-send an unchanged size.
  const st = useRef<{
    ro: ResizeObserver | null;
    timer: ReturnType<typeof setTimeout> | null;
    rows: number;
    cols: number;
    el: HTMLElement | null;
  }>({ ro: null, timer: null, rows: 0, cols: 0, el: null });

  // Re-claim on reconnect. The daemon keys size claims by CONNECTION and drops
  // them when a socket closes, so a reconnected window holds none. The
  // last-sent cache below would otherwise suppress the re-send as "unchanged"
  // and this window would stop constraining its panes until the user happened
  // to resize something. Clearing the cache makes the next measure re-send.
  const wsEpoch = useStore((s) => s.wsEpoch);
  const seenEpoch = useRef(wsEpoch);
  useEffect(() => {
    if (wsEpoch === seenEpoch.current) return; // mount, not a reconnect
    seenEpoch.current = wsEpoch;
    const s = st.current;
    s.rows = 0;
    s.cols = 0;
    if (!s.el) return;
    const rect = s.el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const { w, h } = measureCell();
    s.cols = Math.max(1, Math.floor((rect.width - PAD_X) / w));
    s.rows = Math.max(1, Math.floor((rect.height - PAD_Y) / h));
    sendCommand('pane_resize', { pane_id: paneId, rows: s.rows, cols: s.cols });
  }, [wsEpoch, paneId]);

  return useCallback(
    (el: HTMLElement | null) => {
      const s = st.current;
      // Tear down any previous observer (node detached or being replaced).
      if (s.ro) {
        s.ro.disconnect();
        s.ro = null;
      }
      if (s.timer) {
        clearTimeout(s.timer);
        s.timer = null;
      }
      // Remembered so the reconnect effect above can re-measure without waiting
      // for the ResizeObserver to fire (it won't — nothing on screen moved).
      s.el = el;
      if (!el) return;

      const { w, h } = measureCell();
      const compute = () => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return; // hidden / not laid out
        const cols = Math.max(1, Math.floor((rect.width - PAD_X) / w));
        const rows = Math.max(1, Math.floor((rect.height - PAD_Y) / h));
        if (rows === s.rows && cols === s.cols) return;
        s.rows = rows;
        s.cols = cols;
        sendCommand('pane_resize', { pane_id: paneId, rows, cols });
      };

      const ro = new ResizeObserver(() => {
        if (s.timer) clearTimeout(s.timer);
        s.timer = setTimeout(compute, DEBOUNCE_MS);
      });
      ro.observe(el);
      s.ro = ro;
      compute(); // initial size on attach
    },
    [paneId]
  );
}
