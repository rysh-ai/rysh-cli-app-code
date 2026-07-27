import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useStore, findPane } from '../store';
import { sendCommand } from '../utils/commands';
import { ConversationOutput } from './ConversationOutput';
import type { ConversationMessage } from '../types';

type Turn = { id: string; prompt: string; ts: number; aiStartTurn: number };
type ChatTurns = { base: number; entries: { turnId: string; content: string }[] };

/**
 * BrowserAgentChat is the in-pane "Ask Rysh" panel for a web-mode pane. You prompt
 * the pane's AI; the AI drives THIS pane's embedded browser via the backend
 * browser_action tool. Rendered WhatsApp-style: the user's prompt is a
 * right-aligned bubble, the AI's reply a left-aligned bubble.
 *
 * The AI reply streams on the pane's chat channel (the backend routes a web
 * pane's agentic output there, distinct from shell/ai) tagged with the
 * orchestrator run's turn_id. Chunks accumulate per-turn in store.chatTurns, so
 * an answer is always chunk1+chunk2+… by construction. User prompts are kept in
 * store.browserTurns; each prompt records the absolute chat-turn index at
 * submit time, and its bubble shows the AI turns in [its index, next prompt's
 * index). Indices are stable: capping drops whole old turns and bumps `base`
 * instead of shifting text under fixed offsets (the old char-offset slicing
 * corrupted bubbles once the capped stream started front-trimming).
 */
export const BrowserAgentChat = React.memo(function BrowserAgentChat({ paneId }: { paneId: string }) {
  // Flat chat buffer is only the fallback for history that predates this app
  // session (no turn-tagged entries yet, e.g. right after attach).
  const chatOutput = useStore(
    (s) => s.paneContent[paneId]?.chatOutput ?? findPane(s.snapshot, paneId)?.chat_output ?? ''
  );
  const chatTurns = useStore((s) => s.chatTurns[paneId]) as ChatTurns | undefined;
  // Turns live in the store (keyed by pane) so the transcript survives cycling
  // the pane's input mode away from web and back (which remounts this panel).
  const turns = useStore((s) => s.browserTurns[paneId]) as Turn[] | undefined;
  const addBrowserTurn = useStore((s) => s.addBrowserTurn);
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Whether the pane's browser-agent run is mid-flight. The web pane's agentic
  // output uses the same orchestrator as AI mode, so the daemon stamps the
  // pane status "[agentic] <phase>"; a terminal phase (done/error) means it
  // finished. When running, Ctrl+C (or the Stop button) PAUSES the run.
  const status = useStore((s) => findPane(s.snapshot, paneId)?.status ?? '');
  const running = status.includes('[agentic]') && !status.includes('done') && !status.includes('error');

  // interrupt PAUSES the in-flight agentic run: the daemon cancels the
  // orchestrator context but preserves the conversation as a checkpoint, so a
  // follow-up prompt ("continue" or anything) resumes exactly where it stopped.
  const interrupt = useCallback(() => {
    sendCommand('agentic_cancel', { pane_id: paneId });
  }, [paneId]);

  // Auto-grow the input textarea (wrap to multiple lines) up to a max height.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`;
  }, [text]);

  const submit = useCallback(() => {
    const prompt = text.trim();
    if (!prompt) return;
    setText('');
    // Anchor this turn at the current absolute chat-turn index: its AI reply is
    // whatever turn entries arrive from here on (until the next prompt). Read
    // the freshest store state, not the render closure — a still-streaming
    // previous answer may have appended entries since the last render.
    const ct = useStore.getState().chatTurns[paneId];
    const aiStartTurn = ct ? ct.base + ct.entries.length : 0;
    // The agent reads the page itself via its tools (get_text/screenshot), so we
    // send just the user's prompt — no context block.
    const id = `t-${Date.now()}-${turns?.length ?? 0}`;
    addBrowserTurn(paneId, { id, prompt, ts: Date.now(), aiStartTurn });
    sendCommand('submit_input', { text: prompt, mode: 'prompt', pane_id: paneId });
  }, [text, paneId, turns, addBrowserTurn]);

  // Build the bubble transcript: user prompt (right) + that turn's AI reply (left).
  const messages = useMemo<ConversationMessage[]>(() => {
    const mk = (
      idSuffix: string,
      source: string,
      turnType: string,
      content: string,
      ts: number
    ): ConversationMessage => ({
      turn_id: idSuffix,
      turn_type: turnType,
      conversation_type: 'chat',
      input_type: 'prompt',
      message_source: source,
      content,
      timestamp_ms: ts,
    });

    const ts = turns ?? [];
    const ct = chatTurns ?? { base: 0, entries: [] };
    const total = ct.base + ct.entries.length;
    // Join the AI turn entries whose ABSOLUTE index falls in [startAbs, endAbs).
    // Turn entries never shift (capping drops whole old ones and bumps base), so
    // a bubble's content can only ever be its own run's chunks, concatenated.
    const aiRange = (startAbs: number, endAbs: number): string =>
      ct.entries
        .slice(Math.max(0, startAbs - ct.base), Math.max(0, endAbs - ct.base))
        .map((e) => e.content)
        .join('')
        .trim();
    if (ts.length === 0) {
      // No local prompts yet (e.g. after app restart). Prefer per-turn bubbles
      // when tagged entries exist; else fall back to the flat snapshot buffer.
      if (ct.entries.length > 0) {
        return ct.entries
          .map((e, i) => ({ e, i }))
          .filter(({ e }) => e.content.trim())
          .map(({ e, i }) => mk(`a-${ct.base + i}-${e.turnId}`, 'ai', 'answer', e.content.trim(), Date.now()));
      }
      const ai = chatOutput.trim();
      return ai ? [mk('a0', 'ai', 'answer', ai, Date.now())] : [];
    }
    const out: ConversationMessage[] = [];
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      out.push(mk(`${t.id}-u`, 'human', 'prompt', t.prompt, t.ts));
      const end = i + 1 < ts.length ? ts[i + 1].aiStartTurn : total;
      const ai = aiRange(t.aiStartTurn, end);
      if (ai) out.push(mk(`${t.id}-a`, 'ai', 'answer', ai, t.ts));
    }
    return out;
  }, [turns, chatTurns, chatOutput]);

  return (
    <div className="flex flex-col w-[320px] shrink-0 min-h-0 border-l border-[#333] bg-[#161616]">
      <div className="flex items-center justify-between px-2.5 py-1 text-[11px] font-bold text-[#87ffff] border-b border-[#333] bg-[#1e1e1e] select-none shrink-0">
        <span>Ask Rysh — the AI can browse this page</span>
        {running && (
          <button
            onClick={interrupt}
            title="Interrupt the AI (Ctrl+C) — say “continue” to resume"
            className="ml-2 shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-[#ff8787] bg-[#3a1414] hover:bg-[#4a1a1a] cursor-pointer"
          >
            <span className="animate-pulse">■</span> Stop
          </button>
        )}
      </div>
      {/* ConversationOutput is .pane-output {flex:1; overflow-y:auto}: as a direct
          flex child it fills the middle and scrolls (auto-scroll to latest). */}
      <ConversationOutput paneId={paneId} messages={messages} />
      <div className="flex items-end gap-1 px-2 py-1.5 border-t border-[#333] bg-[#1a1a1a] shrink-0">
        <span className="text-[#5fafff] font-bold select-none leading-6">{'<'}</span>
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder="ask the AI to browse this page…"
          className="flex-1 resize-none bg-transparent border-none outline-none text-[#d4d4d4] font-mono text-[12px] leading-snug placeholder:text-[#555] max-h-32 overflow-y-auto break-words"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Keep multiplexer keybindings from acting on chat keystrokes.
            e.stopPropagation();
            // Ctrl+C while the browser-agent is running: PAUSE it (state is
            // preserved; type "continue" to resume). Only hijack Ctrl+C while
            // a run is in flight, so a normal Ctrl+C (copy on Win/Linux) is
            // untouched otherwise; macOS copy is Cmd+C, always left alone.
            if (running && e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'c') {
              e.preventDefault();
              interrupt();
              return;
            }
            // Enter submits; Shift+Enter inserts a newline (multiline prompt).
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
    </div>
  );
});
