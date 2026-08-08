import React, { useEffect, useRef, useState } from 'react';
import { useStore, findPane } from '../store';
import { sendCommand } from '../utils/commands';
import { voice } from '../utils/voice';
import { getCompletions, completionAvailable } from '../utils/completion';
import type { InputMode } from '../types';

interface Props {
  paneId: string;
  isActive: boolean;
  inputMode: InputMode;
  pipelineActive: boolean;
  shellPid?: number;
  shellCwd?: string;
}

interface CompletionSession {
  candidates: string[]; // full replacement tokens
  names: string[]; // display basenames (dir entries get a trailing /)
  index: number; // -1 = only common prefix filled, nothing selected
  prefixPart: string; // input text before the token
  suffix: string; // input text after the cursor
}

// Reverse-i-search (Ctrl+R) overlay state — bash-style incremental search
// over the pane's shell history (mirrors rysh-cli model_readline.go).
interface SearchState {
  query: string;
  match: string; // '' with a non-empty query = failed search
  offset: number; // Nth match from the newest (Ctrl+R again → older)
  saved: string; // draft before the search opened (Ctrl+G restores)
}

function longestCommonPrefix(arr: string[]): string {
  if (arr.length === 0) return '';
  let p = arr[0];
  for (const s of arr) {
    while (!s.startsWith(p)) p = p.slice(0, -1);
    if (!p) break;
  }
  return p;
}

// findNthMatch returns the nth (0-based) history entry containing query,
// scanning newest → oldest; consecutive duplicates collapse like bash.
function findNthMatch(hist: string[], query: string, n: number): string | null {
  if (!query) return null;
  let count = 0;
  let prev = '';
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i] === prev) continue;
    if (hist[i].includes(query)) {
      if (count === n) return hist[i];
      count++;
      prev = hist[i];
    }
  }
  return null;
}

// shellCommandIncomplete reports whether a shell line is syntactically
// unfinished (unclosed quote or trailing line-continuation backslash) so
// Enter opens a PS2 continuation instead of executing. Comment-aware; a
// backslash is literal inside single quotes (bash rules). Keyword-level
// continuation (for/done, heredocs) stays with the shell's own PS2.
function shellCommandIncomplete(s: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let inComment = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inComment) {
      if (c === '\n') inComment = false;
      continue;
    }
    if (c === '\\' && !inSingle) escaped = true;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (
      c === '#' &&
      !inSingle &&
      !inDouble &&
      (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t' || s[i - 1] === '\n' || s[i - 1] === ';')
    ) {
      inComment = true;
    }
  }
  return escaped || inSingle || inDouble;
}

// basename of a path for the {dir}-style shell prompt ("/" stays "/").
function pathBasename(p: string): string {
  const t = p.replace(/\/+$/, '');
  if (t === '') return '/';
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}

export const PaneInput = React.memo(function PaneInput({
  paneId,
  isActive,
  inputMode,
  pipelineActive,
  shellPid,
  shellCwd,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputText = useStore((s) => s.paneInputTexts[paneId] || '');
  const setPaneInputText = useStore((s) => s.setPaneInputText);
  const setActivePaneOverride = useStore((s) => s.setActivePaneOverride);
  const mode = useStore((s) => s.mode);
  const voiceEnabled = useStore((s) => s.voiceConfig?.enabled === true);
  const voiceState = useStore((s) => s.voiceState);
  const pendingCmd = useStore((s) => s.panePendingCmd[paneId] || '');

  // Shell tab-completion (rysh-cli fac677b).
  const compRef = useRef<CompletionSession | null>(null);
  const pendingCursorRef = useRef<number | null>(null);
  const [compMenu, setCompMenu] = useState<{ names: string[]; index: number } | null>(null);

  // Reverse-i-search overlay (Ctrl+R in shell mode).
  const [search, setSearch] = useState<SearchState | null>(null);

  const shellReadline = !pipelineActive && inputMode === 'shell';

  // Apply a pending caret position after a controlled value update.
  useEffect(() => {
    if (pendingCursorRef.current != null) {
      const pos = pendingCursorRef.current;
      pendingCursorRef.current = null;
      const el = inputRef.current;
      if (el) el.setSelectionRange(pos, pos);
    }
  }, [inputText]);

  // Keep DOM focus on the active pane's input so keystrokes follow pane
  // navigation (ctrl+space arrows, alt+arrows, tab). Typed characters are
  // delivered to whichever pane <input> holds DOM focus, so without this the
  // focus stays on the previously active pane and text goes to the wrong pane.
  // Only steal focus in normal mode (not while a keyboard mode like navigate/
  // pane/rename is active), and re-run when navigate mode returns to normal.
  useEffect(() => {
    if (isActive && mode === 'normal' && document.activeElement !== inputRef.current) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [isActive, mode]);

  function clearCompletion() {
    if (compRef.current) {
      compRef.current = null;
      setCompMenu(null);
    }
  }

  async function handleTab(reverse: boolean) {
    // Only complete in shell mode. Served by the Electron main process in the
    // desktop app, or by the rysh web server over /ws in browser mode (W7).
    if (pipelineActive || inputMode !== 'shell' || !completionAvailable()) return;
    const el = inputRef.current;

    // A menu is already open: cycle the selection.
    const sess = compRef.current;
    if (sess) {
      const n = sess.candidates.length;
      sess.index = reverse ? (sess.index - 1 + n) % n : (sess.index + 1) % n;
      const cand = sess.candidates[sess.index];
      pendingCursorRef.current = sess.prefixPart.length + cand.length;
      setPaneInputText(paneId, sess.prefixPart + cand + sess.suffix);
      setCompMenu({ names: sess.names, index: sess.index });
      return;
    }

    // Start a new completion for the token under the cursor.
    const value = inputText;
    const cursor = el?.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const token = (before.match(/[^\s]*$/) || [''])[0];
    const tokenStart = cursor - token.length;
    const prefixPart = value.slice(0, tokenStart);
    const suffix = value.slice(cursor);
    const isFirstToken = prefixPart.trim() === '';

    const cands = await getCompletions({
      paneId,
      shellPid: shellPid || 0,
      token,
      isFirstToken,
      // OSC 7-reported live cwd (exact after every cd) and the full line up
      // to the cursor for bash programmable completion (git/ssh/docker...).
      cwd: shellCwd || '',
      line: before,
    });
    if (cands.length === 0) return;

    if (cands.length === 1) {
      const c = cands[0];
      const sep = c.isDir ? '/' : ' ';
      pendingCursorRef.current = prefixPart.length + c.value.length + sep.length;
      setPaneInputText(paneId, prefixPart + c.value + sep + suffix);
      clearCompletion();
      return;
    }

    // Multiple matches: fill the common prefix and open a cycling menu.
    const values = cands.map((c) => c.value);
    const cp = longestCommonPrefix(values);
    const insert = cp.length > token.length ? cp : token;
    pendingCursorRef.current = prefixPart.length + insert.length;
    setPaneInputText(paneId, prefixPart + insert + suffix);
    const names = cands.map((c) => {
      const slash = c.value.lastIndexOf('/');
      const base = slash >= 0 ? c.value.slice(slash + 1) : c.value;
      return base + (c.isDir ? '/' : '');
    });
    compRef.current = { candidates: values, names, index: -1, prefixPart, suffix };
    setCompMenu({ names, index: -1 });
  }

  // Auto-focus when this pane becomes active and mode is normal
  useEffect(() => {
    if (isActive && mode === 'normal') {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isActive, mode]);

  // ── Prompt line ──────────────────────────────────────────────────────────
  let promptChar: string;
  let placeholder: string;
  if (pipelineActive) {
    promptChar = '⟫'; // ⟫
    placeholder = 'pipeline prompt...';
  } else if (inputMode === 'prompt') {
    promptChar = '<';
    placeholder = 'ai prompt...';
  } else if (inputMode === 'rysh') {
    promptChar = '##';
    placeholder = 'rysh command...';
  } else if (inputMode === 'chat') {
    promptChar = '@';
    placeholder = 'chat message...';
  } else if (inputMode === 'external') {
    promptChar = '⇋'; // ⇋
    placeholder = 'external message...';
  } else if (inputMode !== 'shell' && inputMode !== 'web') {
    // Dynamic per-humanoid mode (e.g. "slack-bot"): input is routed straight to
    // that humanoid. Mirror chat's @ prompt and name the humanoid in the hint.
    promptChar = '@';
    placeholder = `${inputMode} message...`;
  } else if (pendingCmd) {
    // PS2 continuation while a multi-line shell command is assembled.
    promptChar = '>';
    placeholder = '…continuation (ctrl+c aborts)';
  } else if (shellCwd) {
    // Context-aware shell prompt: {dir} > from the live OSC 7 cwd.
    promptChar = `${pathBasename(shellCwd)} >`;
    placeholder = 'shell command...';
  } else {
    promptChar = '>';
    placeholder = 'shell command...';
  }

  // Reverse-i-search overlay replaces the prompt label and shows the match
  // in the input slot (all keys are intercepted while it is open).
  const searchLabel = search
    ? `${search.query && !search.match ? '(failed reverse-i-search)' : '(reverse-i-search)'}\`${search.query}':`
    : null;
  const displayValue = search ? search.match : inputText;

  function getHistory(): string[] {
    const { snapshot, paneHistory: seededHistory } = useStore.getState();
    if (!snapshot) return [];
    for (const tab of snapshot.tabs) {
      for (const lane of tab.lanes || []) {
        for (const g of lane.pane_groups || []) {
          for (const p of g.panes || []) {
            if (p.id === paneId) {
              // Prefer the seeded history: layout refreshes omit histories on
              // purpose (a layout snapshot carrying them was 5.8 MB, too large
              // to write inside the socket deadline over a tunnel), so the
              // snapshot's copy goes away after the first refresh.
              const seeded = seededHistory[paneId];
              switch (inputMode) {
                case 'prompt': return seeded?.prompt?.length ? seeded.prompt : (p.prompt_history || []);
                case 'rysh': return p.rysh_history || [];
                case 'chat': return p.chat_history || [];
                case 'external': return p.external_history || [];
                default: return seeded?.shell?.length ? seeded.shell : (p.shell_history || []);
              }
            }
          }
        }
      }
    }
    return [];
  }

  // browseHistory: the entries Up/Down walk — filtered by the armed prefix
  // (bash history-search-backward) in shell readline mode.
  function browseHistory(): string[] {
    const history = getHistory();
    if (!shellReadline) return history;
    const prefix = useStore.getState().paneHistoryPrefix[paneId] || '';
    if (!prefix) return history;
    return history.filter((h) => h.startsWith(prefix));
  }

  function handleHistoryUp() {
    const store = useStore.getState();
    const currentIdx = store.paneHistoryIdx[paneId] ?? -1;
    if (currentIdx === -1) {
      // Save current input text before browsing; a non-empty draft arms the
      // prefix filter in shell readline mode.
      const draft = store.paneInputTexts[paneId] || '';
      store.setPaneHistorySaved(paneId, draft);
      store.setPaneHistoryPrefix(paneId, shellReadline && draft ? draft : '');
    }
    const history = browseHistory();
    if (history.length === 0) return;
    const newIdx = Math.min(currentIdx + 1, history.length - 1);
    useStore.getState().setPaneHistoryIdx(paneId, newIdx);
    // History is stored oldest-first (append order), so the most recent command
    // is at the end. Count back from the end: newIdx 0 → most recent.
    setPaneInputText(paneId, history[history.length - 1 - newIdx] || '');
  }

  function handleHistoryDown() {
    const store = useStore.getState();
    const currentIdx = store.paneHistoryIdx[paneId] ?? -1;
    if (currentIdx <= 0) {
      // Return to saved text
      store.setPaneHistoryIdx(paneId, -1);
      store.setPaneInputText(paneId, store.paneHistorySaved[paneId] || '');
      store.setPaneHistoryPrefix(paneId, '');
      return;
    }
    const history = browseHistory();
    const newIdx = Math.min(currentIdx - 1, Math.max(history.length - 1, 0));
    store.setPaneHistoryIdx(paneId, newIdx);
    // Count back from the end to match handleHistoryUp (oldest-first array).
    setPaneInputText(paneId, history[history.length - 1 - newIdx] || '');
  }

  // historyResetAll clears browse index, saved draft and prefix filter.
  function historyResetAll() {
    const store = useStore.getState();
    store.setPaneHistoryIdx(paneId, -1);
    store.setPaneHistoryPrefix(paneId, '');
  }

  // agenticInFlight reports whether this pane is mid-flight in the agentic
  // loop — the LLM/tool execution is running and a cancel would land. The
  // daemon stamps the pane status "[agentic] <phase>"; a terminal phase
  // (done/error) means it already finished. Mirrors the TUI's
  // activePaneIsAgenticInFlight.
  function agenticInFlight(): boolean {
    const p = findPane(useStore.getState().snapshot, paneId);
    const status = p?.status || '';
    if (!status.includes('[agentic]')) return false;
    return !status.includes('done') && !status.includes('error');
  }

  // ── Submit (Enter) — with PS2 continuation in shell mode ─────────────────

  function submitText(rawText: string) {
    const store = useStore.getState();
    let submitMode: string = inputMode;
    if (pipelineActive) submitMode = 'pipeline';

    let text: string;
    if (submitMode === 'shell') {
      // Shell mode strips only trailing whitespace: a LEADING space is the
      // bash HISTCONTROL=ignorespace marker and must reach the daemon intact.
      text = rawText.replace(/[\s]+$/, '');
      const pending = store.panePendingCmd[paneId] || '';
      const combined = pending ? pending + '\n' + text : text;
      if (combined.trim() !== '' && shellCommandIncomplete(combined)) {
        // PS2 continuation: accumulate; the joined logical command executes
        // (and records in history) as ONE entry when it completes.
        store.setPanePendingCmd(paneId, combined);
        setPaneInputText(paneId, '');
        historyResetAll();
        return;
      }
      if (pending) store.setPanePendingCmd(paneId, '');
      text = combined;
    } else {
      text = rawText.trim();
    }

    if (text.trim() !== '') {
      // pane_id pins the input to THIS pane. Routing by "daemon active pane"
      // raced focus under churn: a starved focus command made Enter execute
      // in the previously-active pane (e.g. typed into a running claude CLI).
      sendCommand('submit_input', { text, mode: submitMode, pane_id: paneId });
    }
    setPaneInputText(paneId, '');
    historyResetAll();
  }

  // handleReadlineKey: rysh owns the Ctrl namespace — every Ctrl shortcut is
  // a multiplexer chord (useKeyboard: ctrl+p pane mode, ctrl+l layout, ...)
  // in shell mode exactly like everywhere else. The ONE reserved key is
  // Ctrl+R → reverse-i-search; Ctrl+C additionally aborts the line draft and
  // any PS2 continuation rysh-side (nothing is sent to the shell).
  function handleReadlineKey(e: React.KeyboardEvent<HTMLInputElement>): boolean {
    if (!shellReadline || !e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key.toLowerCase();
    if (k === 'r') {
      // stopPropagation shields the global handler (ctrl+r is voice there).
      e.preventDefault();
      e.stopPropagation();
      setSearch({ query: '', match: '', offset: 0, saved: inputText });
      return true;
    }
    if (k === 'c') {
      // Abort the current draft and any PS2 continuation (matches the
      // "…continuation (ctrl+c aborts)" placeholder). rysh-managed only.
      const store = useStore.getState();
      if ((store.panePendingCmd[paneId] || '') !== '' || inputText !== '') {
        e.preventDefault();
        setPaneInputText(paneId, '');
        store.setPanePendingCmd(paneId, '');
        historyResetAll();
        return true;
      }
    }
    return false;
  }

  // ── Reverse-i-search key handling (captures everything while open) ───────

  function recomputeSearch(query: string, offset: number, saved: string) {
    const hist = getHistory();
    if (!query) {
      setSearch({ query, match: '', offset: 0, saved });
      return;
    }
    let m = findNthMatch(hist, query, offset);
    let off = offset;
    if (m === null) {
      m = findNthMatch(hist, query, 0);
      off = 0;
    }
    setSearch({ query, match: m ?? '', offset: m === null ? 0 : off, saved });
  }

  function handleSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!search) return;
    e.preventDefault();
    e.stopPropagation();
    const endWith = (text: string) => {
      setSearch(null);
      setPaneInputText(paneId, text);
      pendingCursorRef.current = text.length;
    };
    const k = e.key;
    const lower = k.toLowerCase();
    if (e.ctrlKey && lower === 'r') {
      // Step to the next-older match.
      const next = findNthMatch(getHistory(), search.query, search.offset + 1);
      if (next !== null) setSearch({ ...search, offset: search.offset + 1, match: next });
      return;
    }
    if ((e.ctrlKey && lower === 'g') || (e.ctrlKey && lower === 'c')) {
      // Abort — restore the pre-search draft.
      endWith(search.saved);
      return;
    }
    if (k === 'Enter') {
      // Accept and execute the match (bash runs it immediately).
      const match = search.match;
      setSearch(null);
      if (match) {
        setPaneInputText(paneId, '');
        submitText(match);
      }
      return;
    }
    if (k === 'Escape') {
      // End the search, keep the match in the line for editing.
      endWith(search.match || search.saved);
      return;
    }
    if (k === 'Backspace') {
      recomputeSearch(search.query.slice(0, -1), search.offset, search.saved);
      return;
    }
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      recomputeSearch(search.query + k, search.offset, search.saved);
      return;
    }
    // Movement / any other control key terminates the search on the match.
    endWith(search.match || search.saved);
  }

  return (
    <div className="border-t border-[#333] bg-[#1a1a1a] shrink-0">
      {compMenu && compMenu.names.length > 0 && (
        <div className="px-2.5 pt-1 flex flex-wrap gap-x-3 gap-y-0.5 max-h-24 overflow-y-auto text-[12px] font-mono select-none">
          {compMenu.names.map((n, i) => (
            <span
              key={i}
              className={
                i === compMenu.index
                  ? 'px-1 rounded bg-[#00d7d7] text-[#1a1a1a]'
                  : 'text-[#8a8a8a]'
              }
            >
              {n}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center px-2.5 py-1 cursor-text">
      <span
        className={`${search ? 'text-[#ffaf5f]' : 'text-[#5fafff]'} font-bold mr-1 select-none whitespace-nowrap`}
      >
        {searchLabel ?? promptChar}
      </span>
      <input
        ref={inputRef}
        type="text"
        id={'input-' + paneId}
        value={displayValue}
        placeholder={search ? '' : placeholder}
        readOnly={!!search}
        className="flex-1 bg-transparent border-none outline-none text-[#d4d4d4] font-mono text-[13px] caret-[#00d7d7] placeholder:text-[#555]"
        onChange={(e) => {
          clearCompletion();
          setPaneInputText(paneId, e.target.value);
        }}
        onKeyDown={(e) => {
          // While a multiplexer mode (tab/pane/stack/layout/...) is active,
          // keys drive the mode via the global handler — not this input.
          // Without this, ArrowUp during ctrl+s stack navigation ALSO
          // recalled shell history into the input line.
          if (useStore.getState().mode !== 'normal') {
            return; // no preventDefault — let it bubble to useKeyboard
          }
          // Reverse-i-search captures every key while open.
          if (search) {
            handleSearchKey(e);
            return;
          }
          if (e.key === 'Tab') {
            // Shell tab-completion; only meaningful in shell mode.
            if (!pipelineActive && inputMode === 'shell') {
              e.preventDefault();
              void handleTab(e.shiftKey);
              return;
            }
          }
          // Escape closes an open completion menu (and stops the global
          // double-escape mode toggle from firing).
          if (e.key === 'Escape' && compRef.current) {
            e.preventDefault();
            e.stopPropagation();
            clearCompletion();
            return;
          }
          if (e.key !== 'Tab' && e.key !== 'Shift') clearCompletion();
          // Ctrl+C while the pane is running an agentic (AI) prompt: PAUSE
          // the run. The daemon cancels the orchestrator's context (stopping
          // the current tool/LLM call) but preserves the conversation as a
          // checkpoint, so a follow-up AI prompt — "continue" or anything —
          // resumes exactly where it stopped. Works in any input mode since
          // the run belongs to the pane, not the mode. Shell readline keeps
          // its own Ctrl+C (line abort), handled below.
          if (
            e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            e.key.toLowerCase() === 'c' &&
            agenticInFlight()
          ) {
            e.preventDefault();
            e.stopPropagation();
            sendCommand('agentic_cancel', { pane_id: paneId });
            return;
          }
          // bash/readline keys take priority over multiplexer chords while
          // the shell line is focused (mirrors rysh-cli shell_readline_keys).
          if (handleReadlineKey(e)) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitText(inputText);
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            handleHistoryUp();
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            handleHistoryDown();
          }
        }}
        onFocus={() => {
          const currentActive = useStore.getState().getEffectiveActivePaneID();
          if (paneId !== currentActive) {
            setActivePaneOverride(paneId);
            sendCommand('focus_pane_by_id', { id: paneId });
          }
        }}
      />
      {voiceEnabled && isActive && (
        <button
          onMouseDown={(e) => {
            // Don't steal focus from the input; just toggle recording.
            e.preventDefault();
            voice.toggle();
          }}
          title={
            voiceState === 'recording'
              ? 'Stop recording (voice)'
              : voiceState === 'transcribing'
                ? 'Transcribing…'
                : 'Start voice input'
          }
          className={`ml-1 shrink-0 w-6 h-6 rounded flex items-center justify-center text-[13px] select-none cursor-pointer ${
            voiceState === 'recording'
              ? 'text-[#ff5f5f] animate-pulse'
              : voiceState === 'transcribing'
                ? 'text-[#ffff87]'
                : voiceState === 'error'
                  ? 'text-[#ff8787] hover:bg-[#2a2a2a]'
                  : 'text-[#808080] hover:text-[#bbb] hover:bg-[#2a2a2a]'
          }`}
        >
          {voiceState === 'recording' ? '●' : voiceState === 'transcribing' ? '⋯' : '\u{1f3a4}'}
        </button>
      )}
      </div>
    </div>
  );
});
