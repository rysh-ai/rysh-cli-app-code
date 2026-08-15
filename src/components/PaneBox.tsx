import React, { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import { PaneOutput } from './PaneOutput';
import { PaneInput } from './PaneInput';
import { VTScreen } from './VTScreen';
import { ConversationOutput } from './ConversationOutput';
import { WebPaneView } from './WebPaneView';
import { EmailClientView } from './EmailClientView';
import { WhatsAppClientView } from './WhatsAppClientView';
import { AgentsBoardView } from './AgentsBoardView';
import { TouchTermInput, type TermEcho } from './TouchTermInput';
import { TouchKeyMenu } from './TouchKeyMenu';
import { usePaneResize } from '../hooks/usePaneResize';
import { paneShowsLiveApp } from '../utils/paneView';
import type { PaneSnapshot, InputMode, ConversationMessage } from '../types';
import { FIXED_INPUT_MODES } from '../types';

// ── VT wheel forwarding helpers ──
//
// Cached monospace cell metrics for translating a wheel event's pixel position
// into 1-based VT cell coordinates. Measured from the .vt-screen computed font
// (canvas measureText), re-measured only when the font changes.
let vtCellCache: { w: number; h: number; font: string } | null = null;
function vtCellSize(vtEl: HTMLElement): { w: number; h: number } {
  const cs = window.getComputedStyle(vtEl);
  const font = `${cs.fontSize} ${cs.fontFamily}`;
  if (vtCellCache && vtCellCache.font === font) return vtCellCache;
  let w = 7.8;
  const ctx = document.createElement('canvas').getContext('2d');
  if (ctx) {
    ctx.font = font;
    const m = ctx.measureText('M').width;
    if (m > 0) w = m;
  }
  const h = (parseFloat(cs.fontSize) || 13) * 1.2; // .vt-line line-height is 1.2em
  vtCellCache = { w, h, font };
  return vtCellCache;
}

// Encodes one wheel notch as an SGR Extended Mouse Mode (1006) sequence, the
// same encoding the TUI's mouseToSGRBytes produces: \x1b[<{64|65};x;yM.
function wheelToSGR(up: boolean, col: number, row: number): string {
  return `\x1b[<${up ? 64 : 65};${col};${row}M`;
}

// Cursor-key encoding depends on the child program's DECCKM state
// (pane.app_cursor_keys): application mode wants SS3 (\x1bO_), normal mode
// CSI (\x1b[_). Termcap programs (less) IGNORE the wrong form, so arrows
// from web/mobile clients silently did nothing in them before this.
function cursorKeySeq(letter: 'A' | 'B' | 'C' | 'D' | 'H' | 'F', appCursor: boolean): string {
  return (appCursor ? '\x1bO' : '\x1b[') + letter;
}
function seqBytes(seq: string): number[] {
  return Array.from(seq).map((c) => c.charCodeAt(0));
}

function keyToBytes(e: KeyboardEvent, appCursor = false): number[] | null {
  // rysh multiplexer control chords are handled by the global keyboard handler
  // (useKeyboard) even while an interactive program runs — mirror the TUI's
  // modeRaw, which intercepts these and forwards everything else. Returning null
  // here ensures they are NOT also sent to the PTY (e.g. Ctrl+S as XOFF, which
  // would freeze the terminal). Everything else (Ctrl+C/D/R/Z, …) is forwarded.
  const k = e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey &&
      (k === 'o' || k === 'l' || k === 'p' || k === 't' || k === 's' || k === 'y' || k === ' ')) {
    return null;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && k === 'p') {
    return null;
  }

  // Ctrl+key combos
  if (e.ctrlKey && e.key.length === 1) {
    const code = e.key.toLowerCase().charCodeAt(0) - 96; // a=1, b=2, etc.
    if (code >= 1 && code <= 26) return [code];
  }

  // Arrow keys (encoding follows DECCKM, see cursorKeySeq)
  if (e.key === 'ArrowUp') return seqBytes(cursorKeySeq('A', appCursor));
  if (e.key === 'ArrowDown') return seqBytes(cursorKeySeq('B', appCursor));
  if (e.key === 'ArrowRight') return seqBytes(cursorKeySeq('C', appCursor));
  if (e.key === 'ArrowLeft') return seqBytes(cursorKeySeq('D', appCursor));

  // Function keys
  if (e.key === 'Home') return seqBytes(cursorKeySeq('H', appCursor));
  if (e.key === 'End') return seqBytes(cursorKeySeq('F', appCursor));
  if (e.key === 'PageUp') return [27, 91, 53, 126];
  if (e.key === 'PageDown') return [27, 91, 54, 126];
  if (e.key === 'Insert') return [27, 91, 50, 126];
  if (e.key === 'Delete') return [27, 91, 51, 126];

  // Escape
  if (e.key === 'Escape') return [27];
  // Enter
  if (e.key === 'Enter') return [13];
  // Tab
  if (e.key === 'Tab') return [9];
  // Backspace
  if (e.key === 'Backspace') return [127];

  // Regular characters
  if (e.key.length === 1) {
    const encoder = new TextEncoder();
    return Array.from(encoder.encode(e.key));
  }

  return null;
}

// Touch device (phone/tablet): a live interactive pane gets the hidden
// TouchTermInput so tapping the screen can raise the soft keyboard (the
// desktop path captures keystrokes on `document`, which gives a phone nothing
// to focus). Evaluated once — pointer class doesn't change mid-session.
const IS_TOUCH_DEVICE =
  typeof window !== 'undefined' &&
  ((window.matchMedia?.('(pointer: coarse)').matches ?? false) ||
    'ontouchstart' in window);

// bytesToB64 base64-encodes a byte buffer without spreading every byte as a
// function argument (String.fromCharCode(...bytes) overflows the call stack for
// large pastes). Used to forward pasted clipboard text to an interactive PTY.
function bytesToB64(bytes: Uint8Array | number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// Fixed display width of the auto-generated name segment in a pane border
// title. The auto-name is always rendered as exactly this many characters:
// truncated to the first AUTO_NAME_WIDTH chars when longer, right-padded with
// dots when shorter. Mirrors rysh-cli internal/tui/model_view.go (autoNameWidth).
const AUTO_NAME_WIDTH = 20;
// Fixed display width of the mode-name segment (rysh-cli modeNameWidth).
const MODE_NAME_WIDTH = 7;

/** Truncate s to the first `width` chars, or right-pad with dots to `width`.
 *  Mirrors rysh-cli's fixedWidthDots. */
function fixedWidthDots(s: string, width: number): string {
  const r = Array.from(s);
  if (r.length > width) return r.slice(0, width).join('');
  return s + '.'.repeat(width - r.length);
}

/** Display label for an input mode, matching the TUI's paneModeTitleLabel
 *  (shell→Shell, prompt→AI, rysh→Rysh, chat→Chat, external→External, web→Web). */
function paneModeLabel(inputMode: InputMode): string {
  switch (inputMode) {
    case 'shell': return 'Shell';
    case 'prompt': return 'AI';
    case 'rysh': return 'Rysh';
    case 'chat': return 'Chat';
    case 'external': return 'External';
    case 'web': return 'Web';
    // Dynamic per-humanoid mode: show the mode (humanoid) name itself, e.g.
    // "slack-bot". An empty/unknown value falls back to "Shell".
    default: return inputMode || 'Shell';
  }
}

/** Number of decimal digits in n (minimum 1, n assumed >= 0). */
function numDigits(n: number): number {
  if (n <= 0) return 1;
  let d = 0;
  while (n > 0) {
    d++;
    n = Math.floor(n / 10);
  }
  return d;
}

/** Build the pane border title in the format matching the TUI:
 *  "[N/M] auto-name | mode-label | given-name"
 *  or "auto-name | mode-label | given-name" if not stacked.
 *  The auto-name is a fixed 20-char dot-padded column and the mode label a
 *  fixed 7-char dot-padded column, so the " | " separators line up across panes
 *  (the title bar uses the monospace app font). For stacked panes the index is
 *  right-aligned to the count's width so auto-names start at the same column on
 *  every row. The alignment gap uses non-breaking spaces ( ) because the
 *  browser collapses runs of regular spaces under white-space: nowrap.
 *  Mirrors rysh-cli internal/tui/model_view.go paneBorderTitle.
 */
function paneBorderTitle(pane: PaneSnapshot, inputMode: InputMode): string {
  const modeLabel = fixedWidthDots(paneModeLabel(inputMode), MODE_NAME_WIDTH);
  const autoName = fixedWidthDots(pane.title || pane.id.substring(0, 8), AUTO_NAME_WIDTH);

  let base: string;
  if (pane.given_name) {
    base = `${autoName} | ${modeLabel} | ${pane.given_name}`;
  } else {
    base = `${autoName} | ${modeLabel}`;
  }

  if (pane.stack_total && pane.stack_total > 1) {
    const index = (pane.stack_position ?? 0) + 1;
    let gap = 1 + numDigits(pane.stack_total) - numDigits(index);
    if (gap < 1) gap = 1;
    return `[${index}/${pane.stack_total}]${'\u00a0'.repeat(gap)}${base}`;
  }
  return base;
}

/** Return attention icon based on category. */
function attentionIcon(category?: string): string {
  switch (category) {
    case 'approval': return '\u26a0'; // warning sign
    case 'slack': return '\ud83d\udcac'; // speech balloon
    case 'email': return '\ud83d\udce7'; // email
    case 'chatbot': return '\ud83e\udd16'; // robot
    case 'whatsapp': return '\ud83d\udcf1'; // mobile phone
    case 'phone': return '\ud83d\udcde'; // telephone
    default: return '\u25cf'; // filled circle
  }
}

/** Return attention border color class based on category. */
function attentionBorderColor(category?: string): string {
  switch (category) {
    case 'approval': return 'border-[#ff5f00]'; // orange (high priority)
    case 'slack':
    case 'email':
    case 'chatbot':
    case 'whatsapp':
    case 'phone':
      return 'border-[#ffff00]'; // yellow (normal)
    default:
      return 'border-[#00d7d7]'; // default cyan
  }
}

interface Props {
  pane: PaneSnapshot;
  isActive: boolean;
  inputMode: InputMode;
  pipelineActive: boolean;
  isFullscreen?: boolean;
  isCollapsed?: boolean;
  scrollLocked?: boolean;
  conversationMessages?: ConversationMessage[];
  // Lane name shown on the first visible pane of a lane (rysh-cli f59e26c).
  laneName?: string;
}

export const PaneBox = React.memo(function PaneBox({
  pane,
  isActive,
  inputMode,
  pipelineActive,
  isFullscreen,
  isCollapsed,
  scrollLocked,
  conversationMessages,
  laneName,
}: Props) {
  const focusPane = useStore((s) => s.focusPane);
  const setFullscreenPaneID = useStore((s) => s.setFullscreenPaneID);
  const echo = useStore((s) => s.paneEcho[pane.id]);

  // Email-humanoid detection. A pane whose active mode is a humanoid (non-fixed)
  // mode renders the rich email client when that humanoid has an email channel.
  // The channel info lives in humanoidList, which is fetched on demand — if we're
  // in a humanoid mode we don't yet know, request the list so detection
  // self-heals on the next render.
  const humanoidList = useStore((s) => s.humanoidList);
  const isHumanoidMode = !!inputMode && !FIXED_INPUT_MODES.includes(inputMode);
  const humanoidInfo = isHumanoidMode
    ? humanoidList.find((h) => h.name === inputMode)
    : undefined;
  useEffect(() => {
    if (isHumanoidMode && !humanoidInfo) sendCommand('humanoid_list');
  }, [isHumanoidMode, humanoidInfo]);
  const isEmailHumanoid = !!humanoidInfo?.channels?.some((c) => c.type === 'email');
  const isWhatsAppHumanoid = !!humanoidInfo?.channels?.some((c) => c.type === 'whatsapp');
  // Agents board (design 025/028). The board id is forwarded to the server
  // VERBATIM and resolved there (msg.BoardIDFromMeta), so this client and the
  // terminal UI cannot end up showing different boards for one pane — the empty
  // and invalid cases are decided in one place, in Go.
  const isAgentsBoard = pane.pane_type === 'agents-board';
  const boardId = pane.meta?.['board.id'] || '';
  // Insert-mode signal (mirrors rysh-cli dec4b7e): tint the active pane's accent
  // green while keystrokes land in the pane (normal mode — typing into PaneInput
  // or a raw/interactive pane), and keep the cyan accent during the multiplexer's
  // navigation/command overlay modes (tab/pane/stack/layout/prefix/rename/…), where
  // keys drive navigation instead of the pane. Selector returns a boolean, so memoized
  // panes only re-render when the signal flips.
  const insertActive = useStore((s) => s.mode === 'normal');
  // ANSI 42 (#00d75f) green vs the cyan ANSI 44 (#00d7d7) accent. Both literals are
  // present so Tailwind's JIT generates the arbitrary-value border classes.
  const activeAccentBorder = insertActive ? 'border-[#00d75f]' : 'border-[#00d7d7]';

  // Keep this pane's PTY sized to its on-screen content area (in character
  // cells) so interactive apps (vim, claude) fill the whole pane instead of the
  // 80x24 PTY default. Attached to the output container below; collapsed stacked
  // panes never attach it (they render only a title bar), so they don't resize.
  const contentResizeRef = usePaneResize(pane.id);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.button !== 0) return;
      // The click IS the focus: this window switches immediately and does not
      // wait for the daemon to agree. The command below only keeps the daemon's
      // own idea of focus in step (for other clients, and for anything the
      // daemon routes to its active pane).
      focusPane(pane.id);
      sendCommand('focus_pane_by_id', { id: pane.id });
      // The daemon's snapshot pushes can starve under heavy PTY churn (a claude
      // CLI redraw storm), so re-send once if it still disagrees. Purely a
      // daemon-side nudge now — this window's focus is already correct.
      setTimeout(() => {
        const st = useStore.getState();
        if (st.focusedPaneID === pane.id && st.snapshot?.active_pane_id !== pane.id) {
          sendCommand('focus_pane_by_id', { id: pane.id });
        }
      }, 2500);
    },
    [pane.id, focusPane]
  );

  // Native (##native) pass-through: hold the first Esc briefly awaiting the
  // double-Esc exit gesture; on timeout (or any following key) release it to
  // the PTY so readline Meta sequences / vi-mode stay intact.
  const nativeEscTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (nativeEscTimerRef.current) clearTimeout(nativeEscTimerRef.current);
    };
  }, []);

  // When raw mode (local or remote interactive) is active and pane is focused, capture keys
  useEffect(() => {
    if (!(pane.raw_mode || pane.remote_interactive) || !isActive) return;
    const handler = (e: KeyboardEvent) => {
      // Don't capture if user is in a text input. TEXTAREA includes the hidden
      // TouchTermInput, which forwards its own keystrokes — skipping it here
      // prevents double-sending every key on touch devices.
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      // While a multiplexer mode (tab/pane/stack/layout/prefix/…) is active, keys
      // drive the multiplexer via useKeyboard, NOT the interactive program — so
      // pressing j in stack mode rotates the stack instead of also reaching vim.
      // Mirror the TUI, which leaves modeRaw for those modes and stops forwarding
      // to the PTY. Only forward in normal mode.
      if (useStore.getState().mode !== 'normal') return;
      // Leave Cmd/Win-modified keys to the OS/browser: copy/paste/select-all,
      // window switching, etc. A terminal program never uses the Meta modifier,
      // so forwarding it would only send the bare letter to the PTY (Cmd+C → 'c',
      // Cmd+V → 'v') and break clipboard shortcuts. Not calling preventDefault
      // also lets the browser's copy/paste events fire (copy is handled by
      // useClipboard; paste by the effect below).
      if (e.metaKey) return;
      // If this local raw pane has been switched to a rysh input mode
      // (prompt/rysh/chat) via the double-Esc gesture, it renders a normal input
      // box — let keystrokes reach that input instead of forwarding them to the
      // still-running interactive program. Remote-interactive panes always forward.
      // (Escape itself is counted by the global useKeyboard handler, which cycles
      // the mode; the app keeps running and reappears when cycled back to shell.)
      if (!pane.remote_interactive && useStore.getState().getInputMode(pane.id) !== 'shell') {
        return;
      }
      e.preventDefault();
      // ##native pane: double-Esc (with a ~300ms hold on the first Esc)
      // exits pass-through into prompt (AI) mode — mirrors the TUI gesture.
      if (pane.native_mode && !pane.remote_interactive) {
        const flushHeldEsc = () => {
          if (nativeEscTimerRef.current) {
            clearTimeout(nativeEscTimerRef.current);
            nativeEscTimerRef.current = null;
            sendCommand('raw_key_input', { pane_id: pane.id, data: btoa('\x1b') });
          }
        };
        if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (nativeEscTimerRef.current) {
            // Second Esc within the window: leave native mode for AI mode.
            clearTimeout(nativeEscTimerRef.current);
            nativeEscTimerRef.current = null;
            sendCommand('pane_native_mode', { pane_id: pane.id, action: 'off' });
            useStore.getState().setInputMode(pane.id, 'prompt');
          } else {
            nativeEscTimerRef.current = setTimeout(() => {
              nativeEscTimerRef.current = null;
              sendCommand('raw_key_input', { pane_id: pane.id, data: btoa('\x1b') });
            }, 300);
          }
          return;
        }
        // Any other key first flushes a held Esc so the PTY sees the
        // original byte order (Esc could be a readline Meta prefix).
        flushHeldEsc();
      }
      // Predictive local echo: show printable chars instantly at the cursor;
      // Enter/arrows/Ctrl/etc. are left to the authoritative VT stream.
      const st = useStore.getState();
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        st.predictEcho(pane.id, e.key);
      } else if (e.key === 'Backspace') {
        st.backspaceEcho(pane.id);
      } else {
        st.clearEcho(pane.id);
      }
      // Convert key to base64 bytes and send
      const bytes = keyToBytes(e, !!pane.app_cursor_keys);
      if (bytes) {
        const b64 = btoa(String.fromCharCode(...bytes));
        if (pane.remote_interactive && pane.controlling_share_id) {
          // Forward keystrokes to the remote source pane via upstream
          sendCommand('remote_forward_command', { command_type: 'raw_keystroke', payload: b64 });
        } else {
          sendCommand('raw_key_input', { pane_id: pane.id, data: b64 });
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [pane.raw_mode, pane.remote_interactive, pane.controlling_share_id, pane.id, isActive, pane.native_mode, pane.app_cursor_keys]);

  // Paste clipboard text into an interactive (raw / remote) pane. In raw mode no
  // text <input> is focused, so a native paste has nowhere to land — we intercept
  // it and send the clipboard bytes to the PTY (or the remote source). This is how
  // you paste into vim / claude / a pager from the desktop app (Cmd/Ctrl+V,
  // right-click ▸ Paste, or Edit ▸ Paste). Sent as raw bytes (no bracketed-paste
  // wrapper, since we can't know whether the program enabled that mode).
  useEffect(() => {
    if (!(pane.raw_mode || pane.remote_interactive) || !isActive) return;
    const onPaste = (e: ClipboardEvent) => {
      // TEXTAREA = the hidden TouchTermInput; its beforeinput handler forwards
      // insertFromPaste itself.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      e.preventDefault();
      const b64 = bytesToB64(new TextEncoder().encode(text));
      if (pane.remote_interactive && pane.controlling_share_id) {
        sendCommand('remote_forward_command', { command_type: 'raw_keystroke', payload: b64 });
      } else {
        sendCommand('raw_key_input', { pane_id: pane.id, data: b64 });
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [pane.raw_mode, pane.remote_interactive, pane.controlling_share_id, pane.id, isActive]);

  // Wheel scrolling for interactive (raw / VT) panes. The VT view is a live
  // screen with overflow:hidden, so the browser has nothing to scroll — a real
  // terminal makes the wheel work by handing it to the child program instead:
  //   - mouse tracking on (claude, vim, htop — they enable \x1b[?1000h/1006h):
  //     forward each notch as an SGR mouse sequence at the hovered cell, the
  //     exact encoding the TUI's forwardRawMouse sends. The program scrolls
  //     its own content.
  //   - mouse tracking off (plain alt-screen pagers): send arrow keys — the
  //     xterm "alternate scroll" convention, 3 lines per notch.
  // Trackpads emit many small deltaY events; accumulate into whole notches
  // (one notch per cell-row of travel) and cap the burst per event.
  const wheelAccumRef = useRef(0);
  // Shared by the wheel handler (desktop) and the touch-drag handler (phone):
  // both express scrolling as a pixel deltaY at a screen position.
  const forwardVTScroll = useCallback(
    (el: HTMLElement, deltaY: number, clientX: number, clientY: number) => {
      const cell = vtCellSize((el.querySelector('.vt-screen') as HTMLElement) || el);
      wheelAccumRef.current += deltaY;
      let notches = Math.trunc(wheelAccumRef.current / cell.h);
      if (notches === 0) return;
      wheelAccumRef.current -= notches * cell.h;
      notches = Math.max(-5, Math.min(5, notches));
      const up = notches < 0;

      let seq: string;
      if (pane.mouse_enabled || pane.remote_interactive) {
        // 1-based cell coordinates of the hovered position, relative to the
        // .vt-screen content box (2px/4px padding, see the echo overlay).
        const vt = (el.querySelector('.vt-screen') as HTMLElement) || el;
        const rect = vt.getBoundingClientRect();
        const col = Math.max(1, Math.floor((clientX - rect.left - 4) / cell.w) + 1);
        const row = Math.max(1, Math.floor((clientY - rect.top - 2) / cell.h) + 1);
        seq = wheelToSGR(up, col, row).repeat(Math.abs(notches));
      } else {
        // Alternate-scroll: 3 arrow keys per notch (DECCKM-aware — less only
        // reacts to the application form when it enabled it).
        seq = cursorKeySeq(up ? 'A' : 'B', !!pane.app_cursor_keys).repeat(Math.abs(notches) * 3);
      }

      const b64 = btoa(seq);
      if (pane.remote_interactive && pane.controlling_share_id) {
        sendCommand('remote_forward_command', { command_type: 'raw_keystroke', payload: b64 });
      } else if (!pane.remote_interactive) {
        sendCommand('raw_key_input', { pane_id: pane.id, data: b64 });
      }
      // View-only remote share: nowhere to send — drop.
    },
    [pane.mouse_enabled, pane.remote_interactive, pane.controlling_share_id, pane.id, pane.app_cursor_keys]
  );
  const handleVTWheel = useCallback(
    (e: React.WheelEvent) =>
      forwardVTScroll(e.currentTarget as HTMLElement, e.deltaY, e.clientX, e.clientY),
    [forwardVTScroll]
  );

  // ── Touch soft-keyboard bridge ──
  // Same forwarding + predictive echo as the document keydown handler above,
  // but fed by the hidden TouchTermInput textarea (which is what lets a phone
  // tap raise the soft keyboard — see TouchTermInput.tsx).
  const touchInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sendTouchBytes = useCallback(
    (bytes: number[], echoEv: TermEcho) => {
      const st = useStore.getState();
      if (echoEv.kind === 'text' && echoEv.text) {
        for (const ch of echoEv.text) st.predictEcho(pane.id, ch);
      } else if (echoEv.kind === 'backspace') {
        st.backspaceEcho(pane.id);
      } else {
        st.clearEcho(pane.id);
      }
      const b64 = bytesToB64(bytes);
      if (pane.remote_interactive && pane.controlling_share_id) {
        sendCommand('remote_forward_command', { command_type: 'raw_keystroke', payload: b64 });
      } else {
        sendCommand('raw_key_input', { pane_id: pane.id, data: b64 });
      }
    },
    [pane.id, pane.remote_interactive, pane.controlling_share_id]
  );
  // Whether this pane should show its live interactive (VT) screen right now, or a
  // rysh input-mode buffer. A raw pane cycled out of shell mode via double-Esc
  // shows the mode's output + a normal input box while the app keeps running in the
  // PTY (mirrors the CLI's paneShowsLiveApp). See utils/paneView.
  const showsLiveApp = paneShowsLiveApp(pane, isActive, inputMode);
  // Whether the live VT screen is on screen AND we're on a touch device: mount
  // the hidden textarea and make taps on the screen / footer focus it.
  const liveVTVisible =
    showsLiveApp &&
    ((pane.raw_mode && !!pane.vt_screen) ||
      (pane.remote_interactive && !!pane.remote_vt_screen));
  const showTouchInput = IS_TOUCH_DEVICE && liveVTVisible;

  // Must run synchronously inside the tap gesture — mobile browsers only
  // raise the keyboard for focus() calls made during a user gesture. A tap
  // that was really a scroll drag (see the touch effect below) must NOT grab
  // focus — that would pop the keyboard mid-scroll.
  const touchDraggedRef = useRef(false);
  const focusTouchInput = useCallback(() => {
    if (touchDraggedRef.current) return;
    touchInputRef.current?.focus({ preventScroll: true });
  }, []);

  // Special-keys menu (Esc/arrows/Tab/Ctrl chords — keys a phone keyboard
  // can't produce): send the sequence like a keystroke, then re-focus the
  // hidden textarea so the keyboard stays up (same-gesture focus).
  const sendKeySeq = useCallback(
    (seq: string) => {
      sendTouchBytes(Array.from(new TextEncoder().encode(seq)), { kind: 'other' });
      touchInputRef.current?.focus({ preventScroll: true });
    },
    [sendTouchBytes]
  );

  // Finger-drag scrollback (rysh-mobile fad8f75's touch scrollback, web
  // version): the VT view is a live screen, so drags are forwarded to the
  // child program as scroll — SGR mouse wheel when it tracks the mouse
  // (claude, vim), alternate-scroll arrows otherwise (less) — natural
  // direction: content follows the finger. Native (non-passive) listeners
  // because React's root touch listeners are passive and iOS needs
  // preventDefault to suppress rubber-banding.
  const touchScrollElRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = touchScrollElRef.current;
    if (!el || !showTouchInput) return;
    let lastY = 0;
    let travelled = 0;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      lastY = e.touches[0].clientY;
      travelled = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const dy = t.clientY - lastY;
      lastY = t.clientY;
      travelled += Math.abs(dy);
      if (travelled > 12) touchDraggedRef.current = true;
      e.preventDefault();
      forwardVTScroll(el, -dy, t.clientX, t.clientY);
    };
    const onEnd = () => {
      // click fires right after touchend — release the drag flag afterwards.
      setTimeout(() => {
        touchDraggedRef.current = false;
      }, 120);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [showTouchInput, forwardVTScroll]);

  // The content container carries both the PTY-sizing observer and the touch
  // handlers; compose the refs once (an inline arrow ref would re-run
  // usePaneResize's attach/detach on every render).
  const contentRef = useCallback(
    (el: HTMLElement | null) => {
      contentResizeRef(el);
      touchScrollElRef.current = el;
    },
    [contentResizeRef]
  );

  const title = paneBorderTitle(pane, inputMode);
  const hasAttention = !!pane.attention_count && pane.attention_count > 0;

  // ── Collapsed stacked pane: single title bar line ──
  if (isCollapsed) {
    return (
      <div
        data-pane-id={pane.id}
        onMouseDown={handleMouseDown}
        className={`flex items-center px-2.5 py-px text-[11px] border-t select-none overflow-hidden cursor-pointer transition-colors duration-100 ${
          hasAttention
            ? 'bg-[#3a3a00] text-[#ffff87] border-[#555]'
            : 'bg-[#333] text-[#d0d0d0] border-[#555] hover:bg-[#3a3a3a]'
        }`}
      >
        <span className="text-[#666] mr-1">{'\u2503'}</span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">{title}</span>
        {hasAttention && (
          <span className="ml-1 text-[#ffff00] text-[10px] shrink-0">
            {attentionIcon(pane.attention_category)} {pane.attention_count}
          </span>
        )}
      </div>
    );
  }

  // ── Determine border color (attention overrides active state) ──
  let borderClass: string;
  if (hasAttention && !isActive) {
    borderClass = attentionBorderColor(pane.attention_category);
  } else if (isActive) {
    borderClass = activeAccentBorder;
  } else {
    borderClass = 'border-[#585858]';
  }

  // ── Expanded pane: full rendering ──
  // z-40 (not the `z-100` this used to carry — Tailwind v3's z scale stops at
  // 50, so that class generated NO css and the maximized pane fell back to
  // z-index:auto). It has to beat the header strip, which is `relative z-20`
  // whenever the tab bar is vertical and therefore painted OVER the top 30px of
  // a "full screen" pane. It must stay UNDER the right-edge drawers (agent /
  // humanoid / share panels, z-50) and the overlays above them (mode 150,
  // connection 200, dashboard 210, approval 300), which are meant to sit on top
  // of whatever is maximized.
  return (
    <div
      data-pane-id={pane.id}
      onMouseDown={handleMouseDown}
      className={`flex flex-col border rounded-lg overflow-hidden min-h-[80px] flex-1 bg-[#1e1e1e] transition-[border-color] duration-150 cursor-default ${borderClass} ${
        isFullscreen ? `fixed inset-0 z-40 rounded-none border-2 ${activeAccentBorder}` : ''
      }`}
    >
      {/* Title bar */}
      <div
        className={`flex items-center justify-between px-2.5 py-0.5 text-[11px] select-none border-b min-h-[22px] bg-[#222] cursor-default ${
          isActive ? activeAccentBorder : 'border-[#333]'
        }`}
      >
        <span className={`font-bold overflow-hidden text-ellipsis whitespace-nowrap ${isActive ? 'text-white' : 'text-[#d0d0d0]'}`}>
          {title}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {/* Special-keys dropdown (touch devices, live interactive pane):
              Esc/arrows/Tab/Ctrl chords the phone keyboard can't produce. */}
          {showTouchInput && (
            <TouchKeyMenu onKey={sendKeySeq} appCursor={!!pane.app_cursor_keys} />
          )}
          {laneName && (
            <span
              className="text-[#8a8aaf] text-[10px] font-normal whitespace-nowrap"
              title={`lane: ${laneName}`}
            >
              {laneName}
            </span>
          )}
          {hasAttention && (
            <span className="bg-[#5f5f00] text-[#ffff87] px-1 rounded text-[10px] whitespace-nowrap animate-pulse">
              {attentionIcon(pane.attention_category)} {pane.attention_count}
            </span>
          )}
          {pane.pane_type === 'approval' && (
            <span className="bg-[#5f5f00] text-[#ffff87] px-1 rounded text-[10px] whitespace-nowrap">
              APPROVAL
            </span>
          )}
          {isAgentsBoard && (
            <span className="bg-[#5f005f] text-[#ff87ff] px-1 rounded text-[10px] whitespace-nowrap">
              BOARD
            </span>
          )}
          {pane.controlling_share_id && (
            <span className="bg-[#005f5f] text-[#87ffff] px-1 rounded text-[10px] whitespace-nowrap">
              CTRL
            </span>
          )}
          {pane.has_hopped_content && (
            <span className="bg-[#5f005f] text-[#ff87ff] px-1 rounded text-[10px] whitespace-nowrap">
              HOP
            </span>
          )}
          {pane.upstream_connected && (
            <span className="bg-[#005f00] text-[#87ff87] px-1 rounded text-[10px] whitespace-nowrap">
              &uarr;UP
            </span>
          )}
          {pane.raw_mode && (
            <span className="bg-[#870000] text-[#ff8787] px-1 rounded text-[10px] whitespace-nowrap">
              {pane.native_mode ? 'NATIVE' : 'RAW'}
            </span>
          )}
          {pane.sharing && (
            <span className="bg-[#005f00] text-[#87ff87] px-1 rounded text-[10px] whitespace-nowrap">
              SHARED
            </span>
          )}
          {pane.listening_to_id && (
            <span className="bg-[#005f5f] text-[#87ffff] px-1 rounded text-[10px] whitespace-nowrap">
              LISTENING
            </span>
          )}
          {scrollLocked && (
            <span className="bg-[#5f5f00] text-[#ffff55] px-1 rounded text-[10px] whitespace-nowrap">
              &uarr;scrolled
            </span>
          )}
          {/* Maximize/restore controls for web panes: the embedded browser
              captures keyboard focus, so the Ctrl+L→m / Alt+P→f fullscreen
              shortcuts never reach the renderer. These DOM buttons sit in the
              title bar (above the native WebContentsView) and toggle fullscreen
              by click instead. */}
          {inputMode === 'web' && (
            <span className="flex items-center gap-0.5 ml-1 shrink-0">
              <button
                type="button"
                title="Maximize pane"
                disabled={isFullscreen}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setFullscreenPaneID(pane.id);
                }}
                className={`px-1 rounded text-[12px] leading-none ${
                  isFullscreen
                    ? 'text-[#555] cursor-default'
                    : 'text-[#aab] hover:text-white hover:bg-[#333] cursor-pointer'
                }`}
              >
                {'⤢'}
              </button>
              <button
                type="button"
                title="Restore pane"
                disabled={!isFullscreen}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setFullscreenPaneID(null);
                }}
                className={`px-1 rounded text-[12px] leading-none ${
                  !isFullscreen
                    ? 'text-[#555] cursor-default'
                    : 'text-[#aab] hover:text-white hover:bg-[#333] cursor-pointer'
                }`}
              >
                {'⤡'}
              </button>
            </span>
          )}
        </span>
      </div>

      {/* Meta line */}
      <div className="px-2.5 py-0.5 text-[#808080] text-[11px] whitespace-nowrap overflow-hidden text-ellipsis select-none shrink-0 cursor-default">
        {pane.status || 'unknown'} | flex:{pane.flex || 1}
        {pane.sharing && ' | shared'}
        {pane.listening_to_id && ` | listening:${pane.listening_to_id.substring(0, 8)}`}
        {pane.connected_to_pane_id && ` | connected:${pane.connected_to_pane_id.substring(0, 8)}`}
        {pane.registered_humanoid && ` | humanoid:${pane.registered_humanoid}`}
      </div>

      {/* Output. The wrapper is the authoritative PTY-sizing surface: its pixel
          height/width drive usePaneResize, so the VT screen (and any interactive
          program) is sized to exactly this area. */}
      <div
        ref={contentRef}
        className="flex-1 min-h-0 flex flex-col overflow-hidden"
        onWheel={liveVTVisible ? handleVTWheel : undefined}
        // Tapping the live screen focuses the hidden textarea → the phone
        // raises its soft keyboard (click fires synchronously from the tap).
        onClick={showTouchInput ? focusTouchInput : undefined}
        style={showTouchInput ? { touchAction: 'manipulation', position: 'relative' } : undefined}
      >
        {showTouchInput && (
          <TouchTermInput
            ref={touchInputRef}
            onBytes={sendTouchBytes}
            keyToBytes={(e) => keyToBytes(e, !!pane.app_cursor_keys)}
          />
        )}
        {/* Agents board (design 025/028). Dispatched FIRST because none of the
            branches below can apply: the pane type is shell-less, so there is
            no PTY, no VT screen and no output buffer for them to read — and
            `pane.output` for one of these holds stale text from whatever last
            ran near it, which is what made this pane look broken rather than
            unimplemented. Mirrors the TUI's own ordering in
            model_view.go:buildPanePanel. */}
        {isAgentsBoard ? (
          <AgentsBoardView paneId={pane.id} boardId={boardId} />
        ) : inputMode === 'web' ? (
          <WebPaneView paneId={pane.id} />
        ) : isEmailHumanoid ? (
          <EmailClientView paneId={pane.id} humanoidName={inputMode} />
        ) : isWhatsAppHumanoid ? (
          <WhatsAppClientView paneId={pane.id} humanoidName={inputMode} />
        ) : showsLiveApp && pane.raw_mode && pane.vt_screen ? (
          <VTScreen
            lines={pane.vt_screen}
            cursorRow={pane.vt_cursor_row || 0}
            cursorCol={pane.vt_cursor_col || 0}
            echo={echo}
          />
        ) : showsLiveApp && pane.remote_interactive && pane.remote_vt_screen ? (
          <VTScreen
            lines={pane.remote_vt_screen}
            cursorRow={pane.remote_vt_cursor_row || 0}
            cursorCol={pane.remote_vt_cursor_col || 0}
            echo={echo}
          />
        ) : conversationMessages && conversationMessages.length > 0 ? (
          <ConversationOutput
            paneId={pane.id}
            messages={conversationMessages}
          />
        ) : (
          <PaneOutput paneId={pane.id} output={pane.output || ''} />
        )}
      </div>

      {/* Input. While the pane is showing its live interactive app we render the
          raw-mode footer hint; once double-Esc cycles it to a rysh input mode we
          render the normal PaneInput so the user can type prompts/commands (the
          app keeps running and returns when cycled back to shell). */}
      {isAgentsBoard ? (
        // A board pane is SHELL-LESS, so PaneInput here would be a text field
        // whose keystrokes have nothing to reach. Rendering the hint instead is
        // the honest version of the same space — and it names the command that
        // does work, which is the one thing an agent staring at a board it
        // cannot post to actually needs (the lesson of rysh-cli 3ec4283, where
        // the empty-board hint named a binary that did not exist).
        //
        // The TUI additionally offers a compose field that routes a prompt to
        // the board claude. That is a separate surface with its own routing and
        // refusal semantics; it is NOT stubbed here, because a compose box that
        // silently dropped prompts would be this same defect wearing the fix's
        // clothes.
        <div className="px-2.5 py-1 border-t border-[#333] bg-[#1a1a1a] shrink-0 text-[#808080] text-[11px] select-none">
          read-only view · agents post with <code className="text-[#87d7af]">rysh board post &lt;text&gt;</code>
        </div>
      ) : showsLiveApp ? (
        // On touch devices the footer doubles as the "input field": tapping it
        // (like tapping the screen) focuses the hidden textarea so the soft
        // keyboard comes up — the esc/ctrl hints are useless on a phone.
        <div
          className="px-2.5 py-1 border-t border-[#333] bg-[#1a1a1a] shrink-0 text-[#808080] text-[11px] select-none"
          onClick={showTouchInput ? focusTouchInput : undefined}
        >
          {showTouchInput
            ? pane.remote_interactive
              ? 'remote interactive — tap to type'
              : 'interactive app — tap to type'
            : pane.remote_interactive
              ? 'remote interactive — keystrokes forwarded'
              : pane.native_mode
                ? 'native shell — esc esc→ai mode'
                : 'raw mode — esc esc→cycle modes · ctrl+o to escape'}
        </div>
      ) : (
        <PaneInput
          paneId={pane.id}
          isActive={isActive}
          inputMode={inputMode}
          pipelineActive={pipelineActive}
          shellPid={pane.shell_pid}
          shellCwd={pane.shell_cwd}
        />
      )}
    </div>
  );
});
