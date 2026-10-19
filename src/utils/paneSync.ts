import type { PaneSnapshot } from '../types';
import { sendCommand } from './commands';

// Per-pane web sync (rysh-cli `##pane sync on|off`, pane meta `web.sync`).
//
// A pane with web sync off keeps running, but the daemon stops streaming its
// repaints (pane_vt frames and pane_output) to web clients — the fix for a
// browser stalling under a fleet of twenty-plus agent panes that nobody is
// watching individually. This window therefore holds whatever it last received
// for such a pane, and must SAY so: a frozen screen that looks live is worse
// than a blank one. When sync comes back on, the daemon sends the pane's current
// content, so there is nothing to refetch here.

/** The pane meta key the daemon reads (domain.PaneMetaWebSync). */
export const PANE_META_WEB_SYNC = 'web.sync';

/**
 * Whether the daemon has stopped streaming this pane. Mirrors
 * domain.WebSyncPaused: only an explicit "off" (any case, trimmed) counts, so
 * a typo can never make a live pane look frozen.
 */
export function isWebSyncOff(pane: Pick<PaneSnapshot, 'meta'>): boolean {
  return (pane.meta?.[PANE_META_WEB_SYNC] ?? '').trim().toLowerCase() === 'off';
}

/**
 * Turns web sync back on for a pane. Routed as a `##` line through
 * submit_input, the same way the share panel drives `##upstream` — the daemon
 * handles the `##` prefix before any mode routing, so it never reaches the
 * agent running in the pane.
 */
export function resumeWebSync(paneId: string): void {
  sendCommand('submit_input', { text: '##pane sync on', mode: 'rysh', pane_id: paneId });
}
