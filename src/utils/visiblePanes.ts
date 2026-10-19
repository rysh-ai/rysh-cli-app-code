import { useEffect } from 'react';
import { sendCommand } from './commands';

/**
 * Tells the daemon which panes this window is showing, so it streams live VT
 * screens (`pane_vt`) for those panes only.
 *
 * The daemon sends a whole screen per changed interactive pane at up to 10Hz.
 * One busy claude pane alone is ~40 KB/s, and without this every pane in the
 * session — a fleet runs dozens — went to every window, whether it was on
 * screen or not. Over a tunnel on a slow uplink that backlog made typing lag
 * by tens of seconds.
 *
 * Membership is refcounted by id: a pane counts as visible while at least one
 * mounted, expanded PaneBox renders it. Changes are coalesced into one
 * `visible_panes` command. The daemon keeps the set per connection, so it is
 * resent after every reconnect (resendVisiblePanes). A pane added to the set is
 * sent its current screen by the daemon even if it has not changed, so nothing
 * shown here is stale.
 */

const FLUSH_MS = 50;

const counts = new Map<string, number>();
let lastSent: string | null = null; // sorted, joined ids; null = never sent
let timer: ReturnType<typeof setTimeout> | null = null;

function currentKey(): string {
  return [...counts.keys()].sort().join('\n');
}

function flush(): void {
  timer = null;
  const key = currentKey();
  if (key === lastSent) return;
  lastSent = key;
  sendCommand('visible_panes', { pane_ids: key === '' ? [] : key.split('\n') });
}

function schedule(): void {
  if (timer == null) timer = setTimeout(flush, FLUSH_MS);
}

export function retainVisiblePane(id: string): void {
  counts.set(id, (counts.get(id) ?? 0) + 1);
  schedule();
}

export function releaseVisiblePane(id: string): void {
  const n = (counts.get(id) ?? 0) - 1;
  if (n > 0) counts.set(id, n);
  else counts.delete(id);
  schedule();
}

/**
 * Call once a socket opens. A new connection starts unfiltered on the daemon
 * (it streams every pane) until this window names its panes again.
 */
export function resendVisiblePanes(): void {
  lastSent = null;
  if (timer != null) clearTimeout(timer);
  flush();
}

/** Marks paneId visible while `visible` is true and the caller is mounted. */
export function useVisiblePane(paneId: string, visible: boolean): void {
  useEffect(() => {
    if (!visible) return;
    retainVisiblePane(paneId);
    return () => releaseVisiblePane(paneId);
  }, [paneId, visible]);
}

/** Test hook: forget all state. */
export function _resetVisiblePanesForTest(): void {
  counts.clear();
  lastSent = null;
  if (timer != null) clearTimeout(timer);
  timer = null;
}
