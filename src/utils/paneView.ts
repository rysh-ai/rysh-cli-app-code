import type { PaneSnapshot, InputMode } from '../types';

/**
 * paneShowsLiveApp mirrors the CLI TUI's paneShowsLiveApp (rysh-cli
 * internal/tui/model_raw.go): whether a pane should render its live interactive
 * (VT) screen rather than a rysh input-mode buffer.
 *
 * A local interactive app (vim, claude, less, …) runs in the pane's shell PTY, so
 * the ACTIVE pane shows its live screen only while in shell input mode — the
 * double-Esc gesture switches to another input mode (prompt/rysh/chat), which
 * shows that mode's buffer while the app keeps running in the PTY. Background
 * (non-active) interactive panes always show their live screen, and remote/mirror
 * interactive shares are always live.
 *
 * Keeping this in one place lets the keyboard handler (what to forward to the
 * PTY), PaneBox (what to render + when to forward), and any other consumer agree
 * on exactly what a raw pane is showing.
 */
export function paneShowsLiveApp(
  pane: Pick<PaneSnapshot, 'raw_mode' | 'remote_interactive'>,
  isActive: boolean,
  inputMode: InputMode
): boolean {
  if (pane.remote_interactive) return true;
  if (!pane.raw_mode) return false;
  if (isActive) return inputMode === 'shell';
  return true;
}
