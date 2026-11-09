import { useCallback, useEffect, useRef } from 'react';
import { sendCommand } from '../utils/commands';
import { useStore } from '../store';
import { measureVTCell } from '../utils/cellMetrics';
import { pickMobileUI } from '../utils/pickMobileUI';

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
 * The phone UI is the exception: its claim is PASSIVE, which the daemon only
 * honours when no other viewport is showing the pane. A phone joining over a
 * web tunnel would otherwise shrink the pane on the desktop to ~45 columns the
 * moment it connected; instead the phone pans the desktop-sized grid (see the
 * touch handler in PaneBox), and still sizes the pane when it is alone on it.
 *
 * Returns a callback ref to attach to the pane's content container. The callback
 * ref (rather than a useEffect) is deliberate: a stacked pane's content node
 * mounts/unmounts as it expands/collapses, and fullscreen swaps the node — the
 * callback fires with the node on attach and null on detach, so the
 * ResizeObserver is wired up exactly when a measurable node exists.
 */

// Cell size comes from utils/cellMetrics, the one owner shared with VTScreen
// and the wheel path, so the PTY grid matches what actually renders.
const measureCell = measureVTCell;

// The VT content has 2px/4px padding (.vt-screen) — subtract it so the computed
// grid matches what actually renders.
const PAD_X = 8; // 4px left + 4px right
const PAD_Y = 4; // 2px top + 2px bottom
const DEBOUNCE_MS = 80; // coalesce a window-drag burst into one resize

// Which UI mounted is decided once at startup (main.tsx) and never changes, so
// it is read lazily once rather than per claim.
let passiveClaim: boolean | null = null;
function isPassive(): boolean {
  if (passiveClaim === null) passiveClaim = pickMobileUI();
  return passiveClaim;
}

function claimSize(paneId: string, rows: number, cols: number) {
  const params: Record<string, unknown> = { pane_id: paneId, rows, cols };
  if (isPassive()) params.passive = true;
  sendCommand('pane_resize', params);
}

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
    claimSize(paneId, s.rows, s.cols);
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
        claimSize(paneId, rows, cols);
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
