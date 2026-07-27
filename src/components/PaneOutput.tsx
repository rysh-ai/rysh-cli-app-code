import React, { useEffect, useRef, useMemo, useCallback } from 'react';
import { useStore } from '../store';
import { buildOutputHtml } from '../utils/ansi';

interface Props {
  paneId: string;
  output: string;
}

/** True when the live selection overlaps `el` (i.e. the user is selecting here). */
function selectionInside(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const r = sel.getRangeAt(i);
    if (el.contains(r.startContainer) || el.contains(r.endContainer) || r.intersectsNode(el)) {
      return true;
    }
  }
  return false;
}

export const PaneOutput = React.memo(function PaneOutput({ paneId, output }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollLocked = useStore((s) => s.paneScrollLocked[paneId]);
  const setPaneScrollLocked = useStore((s) => s.setPaneScrollLocked);

  const html = useMemo(() => buildOutputHtml(output), [output]);

  // Latest html/scroll state for the selectionchange flush, which fires outside
  // React's render cycle.
  const htmlRef = useRef(html);
  htmlRef.current = html;
  // Live scroll-lock value, updated SYNCHRONOUSLY on user scroll intent.
  // The store copy drives the "↑scrolled" indicator, but store→render→ref
  // propagation is async (React batching): during fast streaming, a pending
  // snap-to-bottom (or the next chunk's writeHtml) read the STALE value and
  // snapped back down, eating the user's scroll-up — "cannot scroll up while
  // the pane streams". The ref is authoritative for all DOM-side decisions;
  // the render assignment below re-syncs it when the store changes from the
  // outside (keyboard shortcuts).
  const scrollLockedRef = useRef(!!scrollLocked);
  scrollLockedRef.current = !!scrollLocked;
  // Set when an update was deferred because a selection was active here.
  const dirtyRef = useRef(false);
  // The html currently written into the DOM, so we can skip redundant innerHTML
  // writes (see the effect below). null until the first write.
  const appliedHtmlRef = useRef<string | null>(null);

  // Single entry point for lock changes driven by user scroll intent: flips
  // the ref first (race-free for writeHtml/rAF) and mirrors into the store.
  const setLock = useCallback(
    (locked: boolean) => {
      scrollLockedRef.current = locked;
      setPaneScrollLocked(paneId, locked);
    },
    [paneId, setPaneScrollLocked]
  );

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      // Re-check at execution time: the user may have scrolled up between the
      // content update that scheduled this snap and the frame it runs in.
      if (scrollLockedRef.current) return;
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    });
  }, []);

  // Write html into the output div while preserving the reading position.
  // Replacing innerHTML resets scrollTop to 0, so when the user has scrolled up
  // (scrollLocked) we restore their offset instead of snapping to the top;
  // otherwise we follow the tail (scroll to bottom), like a terminal.
  const writeHtml = useCallback(
    (nextHtml: string) => {
      const el = ref.current;
      if (!el) return;
      const wasLocked = scrollLockedRef.current;
      const prevTop = el.scrollTop;
      el.innerHTML = nextHtml;
      appliedHtmlRef.current = nextHtml;
      dirtyRef.current = false;
      if (wasLocked) el.scrollTop = prevTop;
      else scrollToBottom();
    },
    [scrollToBottom]
  );

  // Render output into the DOM manually (instead of dangerouslySetInnerHTML) so
  // we can DEFER the update while the user has an active selection in this pane.
  // Replacing innerHTML mid-selection wipes the highlight, which made copying
  // from a live/streaming pane impossible. Deferred updates flush once the
  // selection clears (selectionchange handler below).
  //
  // IMPORTANT: only write when the *content* changed, and keep scrollLocked OUT
  // of the dependency list. scrollLocked flips on every user scroll, and
  // rewriting innerHTML on those toggles reset scrollTop to 0 — which broke
  // scrolling entirely (the view snapped back to the top on every wheel notch or
  // streamed line). The live scrollLocked value is read via the ref in writeHtml.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (html === appliedHtmlRef.current) return;
    if (selectionInside(el)) {
      dirtyRef.current = true;
      return;
    }
    writeHtml(html);
  }, [html, writeHtml]);

  useEffect(() => {
    const onSelChange = (): void => {
      if (!dirtyRef.current) return;
      const el = ref.current;
      if (el && !selectionInside(el)) {
        writeHtml(htmlRef.current);
      }
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [writeHtml]);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 10;
    setLock(!atBottom);
  }, [setLock]);

  // Engage the lock on the wheel-up GESTURE itself, before the browser even
  // updates scrollTop / fires a scroll event. Otherwise a snap scheduled by a
  // streamed chunk lands between the wheel and the scroll event and the view
  // jumps straight back to the bottom.
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.deltaY < 0 && el.scrollHeight > el.clientHeight) setLock(true);
    },
    [setLock]
  );

  return (
    <div
      ref={ref}
      id={'output-' + paneId}
      className="pane-output"
      onScroll={handleScroll}
      onWheel={handleWheel}
    />
  );
});
