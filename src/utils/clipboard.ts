import type { PaneSnapshot } from '../types';
import { paneShowsLiveApp } from './paneView';
import { sendCommand } from './commands';

// Copying a pane OUT to this device (E16 T3 client half; server:
// rysh-cli/internal/web/clipboard.go, protocol §3.11).
//
// This is the direction that did not exist. Typing INTO a pane already worked
// incidentally — PaneBox forwards a native paste to the PTY as raw_key_input —
// but nothing carried a pane's output back, which is the direction you want
// when the useful thing (a stack trace, a generated key) is on a pane's screen
// and your terminal is in another building.
//
// Copy and paste are NOT inverses here and this module never presents them as a
// pair: paste types keystrokes into a PTY and only lands on an interactive
// pane; copy reads a buffer as text and works on any pane. Neither touches the
// clipboard of the machine the server runs on.

/** The buffers the server will serve (Go: clipboardSources). Closed set. */
export type ClipboardSource =
  | 'output'
  | 'ai_output'
  | 'rysh_output'
  | 'chat_output'
  | 'external_output'
  | 'vt_screen'
  | 'remote_vt_screen';

/**
 * The buffer that matches what the pane is SHOWING — the mirror of Body's
 * resolveOutput, which chooses the same text for the screen. Copying `output`
 * while the screen shows the AI plane hands over the wrong text and still looks
 * like it worked.
 *
 * One gap is deliberate and visible rather than papered over: a per-humanoid
 * dynamic mode renders pane.mode_outputs[mode], and the server's source set has
 * no name for those buffers, so this falls back to `output`. The reply carries
 * the source it actually read, and the UI shows it, so the mismatch is legible
 * instead of silent.
 */
export function clipboardSourceFor(
  pane: Pick<PaneSnapshot, 'raw_mode' | 'remote_interactive'>,
  inputMode: string,
  isActive = true
): ClipboardSource {
  if (paneShowsLiveApp(pane, isActive, inputMode as never)) {
    return pane.remote_interactive ? 'remote_vt_screen' : 'vt_screen';
  }
  switch (inputMode) {
    case 'prompt':
      return 'ai_output';
    case 'rysh':
      return 'rysh_output';
    case 'chat':
      return 'chat_output';
    case 'external':
      return 'external_output';
    default:
      return 'output';
  }
}

// Correlation ids are per-connection and short-lived; a counter plus the clock
// is enough to keep two copies in the same session apart, and unlike
// crypto.randomUUID it exists in every context this UI runs in (including a
// plain-http LAN origin, where much of the Web Crypto API is withheld).
let seq = 0;
export function newClipboardRequestId(): string {
  seq += 1;
  return `clip-${Date.now()}-${seq}`;
}

/**
 * Ask the server for one pane buffer. Returns the request id to correlate the
 * `clipboard_content` reply on — the server drops a request without one.
 *
 * max_bytes is deliberately not sent: it can only ask for LESS than the
 * server's 256 KB ceiling, and a client that quietly asks for less throws away
 * output the user asked for. The ceiling still applies and the reply says when
 * it bit.
 */
export function requestPaneCopy(paneId: string, source: ClipboardSource): string {
  const requestId = newClipboardRequestId();
  sendCommand('clipboard_copy', { request_id: requestId, pane_id: paneId, source });
  return requestId;
}

/**
 * Write to the device clipboard, reporting whether it actually happened.
 *
 * Never throws and never assumes: navigator.clipboard is absent in an insecure
 * context (a plain-http LAN origin — exactly how a phone reaches a rysh daemon)
 * and rejects in Safari when the write is not inside a user gesture, which ours
 * is not — the text arrives one round trip after the tap. Both cases must be
 * reported to the caller so the UI can show the text instead, because a silent
 * clipboard failure is indistinguishable from success until the user pastes.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Human-readable size for a copy confirmation. */
export function describeSize(text: string): string {
  const n = text.length;
  if (n < 1024) return `${n} character${n === 1 ? '' : 's'}`;
  return `${Math.round(n / 1024)} KB`;
}
