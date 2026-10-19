/**
 * Main-frame load failures of a web pane (web mode and meeting panes).
 *
 * A failed load used to be logged in the main process only: the pane kept a
 * blank page and no hint that anything went wrong. On 2026-09-29 (E30 MacBook
 * run) Google "Sign in" inside a meeting pane failed with ERR_CONNECTION_CLOSED
 * and the founder saw a white pane. The pane now shows the error with a Retry,
 * and a transient connection failure is retried once on its own.
 */

/** A main-frame load failure, shown in the pane toolbar until the next navigation commits. */
export interface WebPaneLoadError {
  code: number
  description: string
  url: string
}

/** net::ERR_ABORTED — a navigation replaced by another (redirect, click, reload); not a failure. */
const ERR_ABORTED = -3

/**
 * Connection failures that a second attempt usually gets past: the server or a
 * middlebox closed or reset the connection (the TLS close seen on
 * accounts.google.com), or the network changed under the request.
 */
const TRANSIENT = new Map<number, string>([
  [-100, 'ERR_CONNECTION_CLOSED'],
  [-101, 'ERR_CONNECTION_RESET'],
  [-21, 'ERR_NETWORK_CHANGED'],
])

/** The error to show for a did-fail-load, or null when it is not a page failure. */
export function loadErrorFor(
  code: number,
  description: string,
  url: string,
  isMainFrame: boolean,
): WebPaneLoadError | null {
  if (!isMainFrame || code >= 0 || code === ERR_ABORTED) return null
  return { code, description: description || `error ${code}`, url }
}

/**
 * Whether to retry this failure once, automatically. retriedUrl is the URL the
 * pane already retried since its last successful navigation, so a URL that
 * fails twice is shown instead of looping.
 */
export function shouldAutoRetry(err: WebPaneLoadError, retriedUrl: string | undefined): boolean {
  return TRANSIENT.has(err.code) && /^https?:\/\//i.test(err.url) && retriedUrl !== err.url
}
