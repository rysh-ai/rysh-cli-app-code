import { useEffect } from 'react';
import { useStore, findPane } from '../store';
import { sendCommand } from '../utils/commands';
import { voice } from '../utils/voice';
import { paneShowsLiveApp } from '../utils/paneView';

/**
 * Global keyboard handler — mirrors the TUI keybindings exactly.
 * Registered once at the top level.
 */
export function useKeyboard() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const store = useStore.getState();
      const inInput = document.activeElement?.tagName === 'INPUT';

      // ── Side panels: Escape closes them, other keys pass through to panel inputs ──
      if (store.showAgentPanel || store.showHumanoidPanel || store.showSharePanel) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (store.showAgentPanel) useStore.getState().toggleAgentPanel();
          if (store.showHumanoidPanel) useStore.getState().toggleHumanoidPanel();
          if (store.showSharePanel) useStore.getState().toggleSharePanel();
          return;
        }
        return; // Let panel handle its own input
      }

      // ── Approval mode ──
      if (store.mode === 'approval') {
        e.preventDefault();
        handleApprovalMode(e);
        return;
      }
      if (store.mode === 'reject_reason') {
        handleRejectReasonMode(e);
        return;
      }

      // ── Interactive (raw / remote) pane showing its LIVE app: forward to PTY, keep mux chords ──
      // When the active pane runs an interactive program (vim, claude, less, a
      // remote-controlled pane, …) AND is showing that live app, PaneBox forwards
      // keystrokes to the PTY. Mirror the TUI's modeRaw: forward everything to the
      // program EXCEPT the rysh multiplexer control chords (Ctrl+O/L/P/T/S/Y,
      // Ctrl+Space, Alt+P) so you can still navigate / resize / maximize panes and
      // reach prefix mode without leaving the interactive session. PaneBox.keyToBytes
      // drops these same chords so they are never ALSO sent to the PTY.
      //
      // This branch applies only while the raw pane is in SHELL input mode (see
      // activePaneShowsLiveApp): once the double-Esc gesture below cycles it to
      // prompt/rysh/chat, the pane renders a normal input box, so we fall through to
      // the ordinary handling (typing reaches the input; further double-Esc keeps
      // cycling via the standard Escape block).
      if (store.mode === 'normal' && activePaneShowsLiveApp()) {
        // Only CONSECUTIVE Esc presses count as the mode-switch gesture — any other
        // key clears the counter (matches the TUI's handleRawEscGesture).
        if (e.key !== 'Escape') store.setEscCount(0);
        if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
          switch (e.key.toLowerCase()) {
            case 'o': e.preventDefault(); store.setMode('prefix'); return;
            case 'l': e.preventDefault(); store.setMode('layout'); return;
            case 'p': e.preventDefault(); store.setMode('pane'); return;
            case 't': e.preventDefault(); store.setMode('tab'); return;
            case 's': e.preventDefault(); store.setMode('stack'); return;
            case 'y': e.preventDefault(); store.setMode('movepane'); return;
            case ' ': e.preventDefault(); store.setMode('navigate'); return; // Ctrl+Space
          }
        }
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
          e.preventDefault();
          store.setMode('altpprefix');
          return;
        }
        // Double-Esc "switch modes" chord — must work even while an interactive app
        // owns the pane (this was the missing piece: the branch used to return here
        // and swallow Esc, so modes never cycled in a raw pane). PaneBox forwards
        // each Esc to the PTY, so a lone Esc still reaches vim/claude; here we count
        // consecutive presses and cycle the pane's input mode on the second, exactly
        // like the normal-mode Escape handler below. Local auto-detected raw panes
        // only: ##native panes run their own hold-gesture in PaneBox, and a remote
        // interactive share forwards Esc to its source (mirrors the CLI's
        // activePaneLocalRaw gate on handleRawEscGesture).
        if (
          e.key === 'Escape' &&
          !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey &&
          activePaneIsLocalAutoRaw()
        ) {
          clearTimeout(store.escTimer ?? undefined);
          const newCount = store.escCount + 1;
          if (newCount >= 2) {
            store.setEscCount(0);
            const paneID = store.getEffectiveActivePaneID();
            if (paneID) store.cycleInputMode(paneID);
            return;
          }
          store.setEscCount(newCount);
          store.setEscTimer(
            setTimeout(() => {
              useStore.getState().setEscCount(0);
            }, 400)
          );
          return;
        }
        return;
      }

      // ── Escape handling ──
      if (e.key === 'Escape') {
        e.preventDefault();

        if (store.mode !== 'normal') {
          if (store.mode === 'resize') {
            store.setMode('pane');
          } else {
            store.setMode('normal');
          }
          return;
        }

        // NOTE: Escape no longer exits fullscreen — that stole the first Esc of a
        // double-Esc, so modes never cycled while maximized. Exit fullscreen with
        // Ctrl+L m or the restore icon. Esc is reserved for the mode-cycle here
        // (matches the TUI, which also doesn't exit fullscreen on Esc).

        // Double-escape: cycle the active pane's input mode.
        clearTimeout(store.escTimer ?? undefined);
        const newCount = store.escCount + 1;
        if (newCount >= 2) {
          store.setEscCount(0);
          const paneID = store.getEffectiveActivePaneID();
          if (paneID) {
            store.cycleInputMode(paneID);
          }
          return;
        }
        store.setEscCount(newCount);
        store.setEscTimer(
          setTimeout(() => {
            useStore.getState().setEscCount(0);
          }, 400)
        );
        return;
      }

      store.setEscCount(0);

      // Voice prompting hotkey (default ctrl+r). Works while typing too, since
      // it only records the mic and drops the transcript into the active input.
      if (
        voice.isAvailable() &&
        store.mode !== 'renamepane' &&
        store.mode !== 'renametab' &&
        matchesHotkey(e, store.voiceConfig?.hotkey || 'ctrl+r')
      ) {
        e.preventDefault();
        voice.toggle();
        return;
      }

      // Shift+Left/Right reorder the active tab (rysh-cli a458133). Skipped
      // while a text input/rename is focused so shift-selection still works;
      // reliably reachable via tab mode (Ctrl+T then Shift+Left/Right).
      if (
        e.shiftKey &&
        !inInput &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        store.mode !== 'renamepane' &&
        store.mode !== 'renametab'
      ) {
        e.preventDefault();
        sendCommand('move_tab', { direction: e.key === 'ArrowLeft' ? 'left' : 'right' });
        return;
      }

      // '.' exits any non-text mode (like TUI)
      if (e.key === '.' && !inInput && store.mode !== 'normal' && store.mode !== 'renamepane' && store.mode !== 'renametab') {
        e.preventDefault();
        if (store.mode === 'resize') {
          store.setMode('pane');
        } else {
          store.setMode('normal');
        }
        return;
      }

      // ── Mode-specific handling ──
      if (store.mode === 'tab') { e.preventDefault(); handleTabMode(e); return; }
      if (store.mode === 'pane') { e.preventDefault(); handlePaneMode(e); return; }
      if (store.mode === 'stack') { e.preventDefault(); handleStackMode(e); return; }
      if (store.mode === 'movepane') { e.preventDefault(); handleMovePaneMode(e); return; }
      if (store.mode === 'layout') { e.preventDefault(); handleLayoutMode(e); return; }
      if (store.mode === 'resize') { e.preventDefault(); handleResizeMode(e); return; }
      if (store.mode === 'prefix') { e.preventDefault(); handlePrefixMode(); return; }
      if (store.mode === 'altpprefix') { e.preventDefault(); handleAltPPrefixMode(e); return; }
      if (store.mode === 'navigate') { e.preventDefault(); handleNavigateMode(e); return; }
      if (store.mode === 'renamepane') { handleRenamePaneMode(e); return; }
      if (store.mode === 'renametab') { handleRenameTabMode(e); return; }

      // ── Global shortcuts (normal mode) ──
      if (e.ctrlKey && e.key === 't') { e.preventDefault(); store.setMode('tab'); return; }
      if (e.ctrlKey && e.key === 'p') { e.preventDefault(); store.setMode('pane'); return; }
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); store.setMode('stack'); return; }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); store.setMode('movepane'); return; }
      if (e.ctrlKey && e.key === 'l') { e.preventDefault(); store.setMode('layout'); return; }
      if (e.ctrlKey && e.key === 'o') { e.preventDefault(); store.setMode('prefix'); return; }
      if (e.altKey && e.key === 'p') { e.preventDefault(); store.setMode('altpprefix'); return; }
      if (e.ctrlKey && e.key === ' ') { e.preventDefault(); store.setMode('navigate'); return; }
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); sendCommand('create_pane'); return; }

      if (!inInput) {
        if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          sendCommand(e.shiftKey ? 'focus_prev_pane' : 'focus_next_pane');
          return;
        }
        if (e.key === '[') { e.preventDefault(); sendCommand('focus_prev_tab'); return; }
        if (e.key === ']') { e.preventDefault(); sendCommand('focus_next_tab'); return; }
      }

      // Alt+Arrow navigation and panel toggles
      if (e.altKey) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); sendCommand('focus_prev_tab'); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); sendCommand('focus_next_tab'); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); sendCommand('focus_prev_pane'); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); sendCommand('focus_next_pane'); return; }
        if (e.key === 'b') { e.preventDefault(); sendCommand('focus_prev_tab'); return; }
        if (e.key === 'f' && !e.ctrlKey) { e.preventDefault(); sendCommand('focus_next_tab'); return; }
        if (e.key === 'a') {
          e.preventDefault();
          useStore.getState().toggleAgentPanel();
          sendCommand('agent_list');
          return;
        }
        if (e.key === 'h') {
          e.preventDefault();
          useStore.getState().toggleHumanoidPanel();
          sendCommand('humanoid_list');
          return;
        }
      }

      // Scroll
      if (e.key === 'PageUp') { e.preventDefault(); scrollActivePane(-1); return; }
      if (e.key === 'PageDown') { e.preventDefault(); scrollActivePane(1); return; }
      if (e.key === 'Home') { e.preventDefault(); scrollActivePaneToTop(); return; }
      if (e.key === 'End') { e.preventDefault(); scrollActivePaneToBottom(); return; }
      if (e.shiftKey && e.key === 'ArrowUp') { e.preventDefault(); scrollActivePaneLine(-3); return; }
      if (e.shiftKey && e.key === 'ArrowDown') { e.preventDefault(); scrollActivePaneLine(3); return; }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}

// ── Mode handlers ──

// activePaneShowsLiveApp reports whether the effective active pane is currently
// showing a live interactive program — local raw mode (vim/claude/less/…) or a
// remote-interactive controlled pane — AND is in shell input mode (so keystrokes
// belong to the program, not a rysh input box). The live raw_mode arrives on the
// content-plane VT stream (store.paneVT) and can lead the layout snapshot, so
// consult the streamed value first and fall back to the snapshot (matches the
// rehydration PaneBox renders from — see Body.tsx rehydratePane). Cycling the pane
// to prompt/rysh/chat via double-Esc flips this to false, so keystrokes then reach
// the input box instead of the PTY. Mirrors the CLI's paneShowsLiveApp for the
// active pane.
function activePaneShowsLiveApp(): boolean {
  const store = useStore.getState();
  const id = store.getEffectiveActivePaneID();
  if (!id) return false;
  const vt = store.paneVT?.[id];
  const snap = findPane(store.snapshot, id);
  const raw = vt?.raw_mode ?? snap?.raw_mode ?? false;
  const remote = vt?.remote_interactive ?? snap?.remote_interactive ?? false;
  return paneShowsLiveApp({ raw_mode: raw, remote_interactive: remote }, true, store.getInputMode(id));
}

// activePaneIsLocalAutoRaw reports whether the effective active pane is a LOCAL
// auto-detected interactive (raw) pane — an alt-screen app (claude/vim/less/…)
// running in the pane's own shell PTY — as opposed to a ##native pass-through
// (its own hold-gesture in PaneBox) or a remote/mirror interactive share (Esc
// forwards to the source). These are the panes the global double-Esc mode-switch
// gesture applies to. Mirrors the CLI's activePaneLocalRaw.
function activePaneIsLocalAutoRaw(): boolean {
  const store = useStore.getState();
  const id = store.getEffectiveActivePaneID();
  if (!id) return false;
  const vt = store.paneVT?.[id];
  const snap = findPane(store.snapshot, id);
  const raw = vt?.raw_mode ?? snap?.raw_mode ?? false;
  const remote = vt?.remote_interactive ?? snap?.remote_interactive ?? false;
  const native = !!snap?.native_mode;
  return raw && !remote && !native;
}

// matchesHotkey compares a KeyboardEvent against a Bubble Tea-style hotkey
// string (e.g. "ctrl+r", "alt+v") so the app honours the same [voice].hotkey
// configured for the TUI.
function matchesHotkey(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  let key = parts[parts.length - 1];
  if (key === 'space') key = ' ';
  const mods = new Set(parts.slice(0, -1));
  const wantCtrl = mods.has('ctrl') || mods.has('control');
  const wantAlt = mods.has('alt') || mods.has('option');
  const wantShift = mods.has('shift');
  const wantMeta = mods.has('cmd') || mods.has('command') || mods.has('meta') || mods.has('super');
  if (e.ctrlKey !== wantCtrl || e.altKey !== wantAlt || e.shiftKey !== wantShift || e.metaKey !== wantMeta) {
    return false;
  }
  return e.key.toLowerCase() === key;
}

function handleTabMode(e: KeyboardEvent) {
  const store = useStore.getState();
  // Shift+Left/Right reorder the active tab (rysh-cli a458133).
  if (e.shiftKey && e.key === 'ArrowLeft') { sendCommand('move_tab', { direction: 'left' }); return; }
  if (e.shiftKey && e.key === 'ArrowRight') { sendCommand('move_tab', { direction: 'right' }); return; }
  switch (e.key) {
    case 'ArrowRight': case 'l': case ']': case 'ArrowDown': case 'j':
      sendCommand('focus_next_tab'); break;
    case 'ArrowLeft': case 'h': case '[': case 'ArrowUp': case 'k':
      sendCommand('focus_prev_tab'); break;
    case 'n':
      sendCommand('create_tab');
      store.setMode('normal');
      break;
    case 'r': case 'R': {
      // Rename the active tab via an inline input (mirrors TUI ctrl+t r).
      const snap = store.snapshot;
      const activeTab = snap?.tabs?.find((t) => t.id === snap.active_tab_id);
      store.setRenameText(activeTab?.title || '');
      store.setMode('renametab');
      break;
    }
    case '1': case '2': case '3': case '4': case '5':
    case '6': case '7': case '8': case '9':
      sendCommand('focus_tab_index', { index: parseInt(e.key) - 1 });
      store.setMode('normal');
      break;
  }
}

function handlePaneMode(e: KeyboardEvent) {
  const store = useStore.getState();
  switch (e.key) {
    case 'n': sendCommand('create_pane'); store.setMode('normal'); break;
    case 'v': sendCommand('create_pane_down'); store.setMode('normal'); break;
    case 's': sendCommand('create_stacked_pane'); store.setMode('normal'); break;
    case 'x': sendCommand('close_pane'); store.setMode('normal'); break;
    case 'r': case 'R': {
      // Rename the active pane (same flow as alt+p c).
      const paneID = store.getEffectiveActivePaneID();
      if (paneID) {
        store.setRenamePaneID(paneID);
        // Pre-fill with the pane's existing given-name (mirrors rysh-cli 99b5f97);
        // empty when the pane only has an auto-generated title.
        store.setRenameText(findPane(store.snapshot, paneID)?.given_name || '');
        store.setMode('renamepane');
      } else {
        store.setMode('normal');
      }
      break;
    }
    case 'p': sendCommand('toggle_pipeline_mode'); break;
    case 'y': {
      // Switch to rysh input mode
      const paneID = store.getEffectiveActivePaneID();
      if (paneID) store.setInputMode(paneID, 'rysh');
      store.setMode('normal');
      break;
    }
    case 'c': {
      // Switch to chat input mode
      const paneID = store.getEffectiveActivePaneID();
      if (paneID) store.setInputMode(paneID, 'chat');
      store.setMode('normal');
      break;
    }
    case 'd': {
      // Detach — no web equivalent, just show a visual hint
      store.setMode('normal');
      break;
    }
  }
}

function handleStackMode(e: KeyboardEvent) {
  switch (e.key) {
    case 'j': case 'ArrowDown': case 'ArrowRight': case 'l':
      sendCommand('stacked_pane_next'); break;
    case 'k': case 'ArrowUp': case 'ArrowLeft': case 'h':
      sendCommand('stacked_pane_prev'); break;
    case '1': case '2': case '3': case '4': case '5':
    case '6': case '7': case '8': case '9':
      // Jump straight to the stacked pane shown as [n/N]: the typed digit is the
      // 1-based position, so subtract one for the 0-based index. Out-of-range
      // selections are ignored by the pane group. Stays in stack mode (mirrors
      // the TUI) so further digits/arrows can be pressed; esc/. exits.
      sendCommand('stacked_pane_select', { index: parseInt(e.key) - 1 });
      break;
  }
}

// Move-pane mode (ctrl+y): reorder the active pane within its group stack.
// Up/k moves it toward the front (index 0), down/j toward the back. The mode
// stays active so multiple moves can be chained; any other key exits. Mirrors
// TUI 44b7376 / MsgStackedPaneMove.
function handleMovePaneMode(e: KeyboardEvent) {
  const store = useStore.getState();
  switch (e.key) {
    case 'k': case 'ArrowUp':
      sendCommand('stacked_pane_move', { direction: 'up' });
      return;
    case 'j': case 'ArrowDown':
      sendCommand('stacked_pane_move', { direction: 'down' });
      return;
  }
  store.setMode('normal');
}

// Rename-tab mode (ctrl+t r): inline text entry for the active tab title.
// Enter confirms, Escape cancels (Escape is handled by the global handler).
// Mirrors TUI rename-tab (f59e26c / MsgRenameTab).
function handleRenameTabMode(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    useStore.getState().setMode('normal');
    useStore.getState().setRenameText('');
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const store = useStore.getState();
    const text = store.renameText.trim();
    if (text) {
      sendCommand('rename_tab', { title: text });
    }
    store.setMode('normal');
    store.setRenameText('');
    return;
  }
  // Let the rename input handle other keys normally.
}

function handleLayoutMode(e: KeyboardEvent) {
  const store = useStore.getState();
  switch (e.key) {
    // Resize lane width
    case 'ArrowRight':
      sendCommand('resize_pane_width', { delta: 1 }); break;
    case 'ArrowLeft':
      sendCommand('resize_pane_width', { delta: -1 }); break;
    // Resize pane height
    case 'ArrowUp':
      sendCommand('resize_pane_height', { delta: 1 }); break;
    case 'ArrowDown':
      sendCommand('resize_pane_height', { delta: -1 }); break;
    // Equalize horizontal (all lane widths)
    case 'h': case '=':
      sendCommand('equalize_horizontal'); break;
    // Equalize vertical (all pane heights in lane)
    case 'v':
      sendCommand('equalize_vertical'); break;
    // Swap active lane with next
    case 's':
      sendCommand('swap_pane'); break;
    // Toggle fullscreen
    case 'm': {
      const paneID = store.getEffectiveActivePaneID();
      if (paneID) {
        store.setFullscreenPaneID(store.fullscreenPaneID === paneID ? null : paneID);
      }
      break;
    }
  }
}

function handleResizeMode(e: KeyboardEvent) {
  const store = useStore.getState();
  switch (e.key) {
    case 'h': case 'ArrowLeft':
      sendCommand('resize_pane', { delta: -1 }); break;
    case 'l': case 'ArrowRight':
      sendCommand('resize_pane', { delta: 1 }); break;
    case 'k': case 'ArrowUp':
      sendCommand('resize_pane_height', { delta: 1 }); break;
    case 'j': case 'ArrowDown':
      sendCommand('resize_pane_height', { delta: -1 }); break;
  }
  if (e.ctrlKey && e.key === 'p') {
    store.setMode('normal');
  }
}

function handlePrefixMode() {
  useStore.getState().setMode('normal');
}

function handleAltPPrefixMode(e: KeyboardEvent) {
  const store = useStore.getState();
  if (e.key === 'f') {
    store.setMode('normal');
    const paneID = store.getEffectiveActivePaneID();
    if (paneID) {
      store.setFullscreenPaneID(store.fullscreenPaneID === paneID ? null : paneID);
    }
    return;
  }
  // Any other key cancels
  store.setMode('normal');
}

function handleNavigateMode(e: KeyboardEvent) {
  switch (e.key) {
    case 'h': case 'ArrowLeft': sendCommand('focus_pane_left'); break;
    case 'l': case 'ArrowRight': sendCommand('focus_pane_right'); break;
    case 'k': case 'ArrowUp': sendCommand('focus_pane_up'); break;
    case 'j': case 'ArrowDown': sendCommand('focus_pane_down'); break;
  }
}

function handleRenamePaneMode(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    useStore.getState().setMode('normal');
    useStore.getState().setRenamePaneID(null);
    useStore.getState().setRenameText('');
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const store = useStore.getState();
    const text = store.renameText.trim();
    if (text) {
      sendCommand('rename_pane', { title: text });
    }
    store.setMode('normal');
    store.setRenamePaneID(null);
    store.setRenameText('');
    return;
  }
  // Let the rename input handle other keys normally
}

function handleApprovalMode(e: KeyboardEvent) {
  switch (e.key) {
    case 'y': submitApproval('yes'); break;
    case 'Y': submitApproval('yes_always'); break;
    case 'n': submitApproval('no'); break;
    case 'N':
      useStore.getState().setMode('reject_reason');
      break;
    case 'Escape': submitApproval('no'); break;
  }
}

function handleRejectReasonMode(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    useStore.getState().setMode('approval');
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const input = document.getElementById('rejection-reason') as HTMLInputElement | null;
    const reason = input?.value.trim() || '';
    submitApproval('no_with_explanation', reason);
    if (input) input.value = '';
  }
}

function submitApproval(decision: string, reason?: string) {
  const store = useStore.getState();
  if (!store.pendingApproval) return;
  sendCommand('approval_response', {
    pane_id: store.pendingApproval.pane_id,
    request_id: store.pendingApproval.request.request_id,
    decision,
    reason: reason || '',
  });
  store.setPendingApproval(null);
  store.setMode('normal');
}

// ── Scroll helpers ──

function scrollActivePane(direction: number) {
  const paneID = useStore.getState().getEffectiveActivePaneID();
  if (!paneID) return;
  const el = document.getElementById('output-' + paneID);
  if (!el) return;
  el.scrollTop += direction * el.clientHeight * 0.8;
}

function scrollActivePaneLine(lines: number) {
  const paneID = useStore.getState().getEffectiveActivePaneID();
  if (!paneID) return;
  const el = document.getElementById('output-' + paneID);
  if (!el) return;
  el.scrollTop += lines * 18;
}

function scrollActivePaneToTop() {
  const store = useStore.getState();
  const paneID = store.getEffectiveActivePaneID();
  if (!paneID) return;
  const el = document.getElementById('output-' + paneID);
  if (el) { el.scrollTop = 0; store.setPaneScrollLocked(paneID, true); }
}

function scrollActivePaneToBottom() {
  const store = useStore.getState();
  const paneID = store.getEffectiveActivePaneID();
  if (!paneID) return;
  const el = document.getElementById('output-' + paneID);
  if (el) { el.scrollTop = el.scrollHeight; store.setPaneScrollLocked(paneID, false); }
}
