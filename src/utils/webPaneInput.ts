// webpane_input — the client half of E-16 (server: rysh-cli
// internal/web/webpane_input.go).
//
// A browser-mode web pane is a JPEG of a page running in a server-side
// Chromium, scaled to whatever size the pane happens to be. The server owns the
// coordinate mapping: it published the frame's SOURCE size and maps each axis
// itself. The client's whole job is to report, faithfully, what it drew —
//
//   x, y                            the point, relative to the frame image
//   display_width, display_height   that image's MEASURED size
//
// — and to scale nothing. Sending the source size, or pre-scaling the point,
// double-maps every click; sending a CSS max-width instead of the measured rect
// misses by however much the image was letterboxed.

export type WebPaneInputKind = 'click' | 'key' | 'scroll' | 'move';

/** The part of a mouse/wheel event this module needs (keeps it testable). */
export interface PointerLike {
  clientX: number;
  clientY: number;
}

/** The part of a keyboard/mouse event that carries modifier state. */
export interface ModifierLike {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** A webpane_input command payload, matching webPaneInputCmd's json tags. */
export interface WebPaneInputParams {
  pane_id: string;
  kind: WebPaneInputKind;
  x?: number;
  y?: number;
  display_width?: number;
  display_height?: number;
  button?: string;
  key?: string;
  modifiers?: string[];
  delta_x?: number;
  delta_y?: number;
}

/**
 * Modifier names as the server's press_key parses them (rysh-cli
 * internal/cdp/actions.go doPressKey: alt|option, ctrl|control, meta|cmd, shift).
 */
export function modifiersOf(e: ModifierLike): string[] {
  const mods: string[] = [];
  if (e.altKey) mods.push('alt');
  if (e.ctrlKey) mods.push('ctrl');
  if (e.metaKey) mods.push('meta');
  if (e.shiftKey) mods.push('shift');
  return mods;
}

/** MouseEvent.button → the name webPaneButtonIndex maps back to a CDP button. */
export function buttonName(button: number | undefined): string {
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'left';
}

/**
 * The coordinate half of a pointer payload, or null when the frame has no
 * measurable size (0x0 — not laid out yet, or a hidden pane). The server
 * rejects a zero display size with a webpane_error, so there is nothing to gain
 * from sending one.
 */
export function pointerAt(
  paneId: string,
  kind: 'click' | 'scroll' | 'move',
  e: PointerLike,
  rect: { left: number; top: number; width: number; height: number }
): WebPaneInputParams | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    pane_id: paneId,
    kind,
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    display_width: rect.width,
    display_height: rect.height,
  };
}

/**
 * Bare modifier presses are not keystrokes: forwarding "Shift" would press
 * Shift as the MAIN key server-side, and the real modifier state already rides
 * along on the next key's `modifiers`.
 */
const BARE_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

export function isForwardableKey(key: string): boolean {
  return key !== '' && key !== 'Unidentified' && !BARE_MODIFIERS.has(key);
}

/**
 * The rysh multiplexer control chords (Ctrl+O/L/P/T/S/Y, Ctrl+Space, Alt+P).
 * A surface that swallows the keyboard must leave these alone or there is no
 * way back out of the pane — the same rule PaneBox.keyToBytes applies to an
 * interactive PTY, and for the same reason. Duplicated rather than shared
 * because PaneBox's copy is a byte-encoding concern, not an input-routing one.
 */
export function isMuxChord(e: ModifierLike & { key: string }): boolean {
  const k = e.key.toLowerCase();
  if (
    e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.shiftKey &&
    (k === 'o' || k === 'l' || k === 'p' || k === 't' || k === 's' || k === 'y' || k === ' ')
  ) {
    return true;
  }
  return !!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && k === 'p';
}

/**
 * Pointer moves fire at screen refresh rate and the server answers EVERY input
 * with a fresh JPEG frame, so an unthrottled drag is a screenshot storm on the
 * socket. One move per window is enough to drive hover states.
 */
export const MOVE_THROTTLE_MS = 100;
