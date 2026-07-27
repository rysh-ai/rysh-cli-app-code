import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore, findPane } from '../store';
import { sendCommand } from '../utils/commands';
import { PaneOutput } from './PaneOutput';

interface Props {
  paneId: string;
  humanoidName: string;
}

/**
 * EmailAgentChat is the in-view "Ask the bot" dock for the email client — the
 * email analog of BrowserAgentChat. You prompt the email humanoid here (instead
 * of the pane's bottom input); its draft previews and "type send" prompts stream
 * back into this humanoid's per-mode output buffer, shown above.
 *
 * It deliberately reuses the SAME routing as the pane's humanoid-mode input
 * (submit_input with mode = humanoid name), so the draft → "send" flow behaves
 * identically to the terminal client — just rendered beside the open email.
 */
export const EmailAgentChat = React.memo(function EmailAgentChat({ paneId, humanoidName }: Props) {
  // The humanoid's mode buffer is the authoritative transcript: it holds both the
  // echoed prompts and the bot's streamed replies/draft previews. Prefer the live
  // content-plane buffer; fall back to the snapshot for restore-on-startup.
  const output = useStore(
    (s) =>
      s.paneContent[paneId]?.modeOutputs?.[humanoidName] ??
      findPane(s.snapshot, paneId)?.mode_outputs?.[humanoidName] ??
      ''
  );
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the input textarea up to a max height (mirrors BrowserAgentChat).
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
    sendCommand('submit_input', { text: prompt, mode: humanoidName, pane_id: paneId });
  }, [text, humanoidName, paneId]);

  return (
    <div className="flex flex-col w-[300px] shrink-0 min-h-0 border-l border-[#333] bg-[#161616]">
      <div className="px-2.5 py-1 text-[11px] font-bold text-[#87ffff] border-b border-[#333] bg-[#1e1e1e] select-none shrink-0">
        Ask {humanoidName} — drafts &amp; replies
      </div>
      {/* PaneOutput is .pane-output {flex:1; overflow-y:auto}: as a direct flex
          child it fills the middle and auto-scrolls to the latest output. */}
      <PaneOutput paneId={paneId} output={output} />
      <div className="flex items-end gap-1 px-2 py-1.5 border-t border-[#333] bg-[#1a1a1a] shrink-0">
        <span className="text-[#5fafff] font-bold select-none leading-6">{'>'}</span>
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder="tell the bot what to do… then type “send”"
          className="flex-1 resize-none bg-transparent border-none outline-none text-[#d4d4d4] font-mono text-[12px] leading-snug placeholder:text-[#555] max-h-32 overflow-y-auto break-words"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Keep the multiplexer's global keybindings from acting on keystrokes.
            e.stopPropagation();
            // Enter submits; Shift+Enter inserts a newline.
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
