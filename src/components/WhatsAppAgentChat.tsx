import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore, findPane } from '../store';
import { sendCommand } from '../utils/commands';
import { PaneOutput } from './PaneOutput';

interface Props {
  paneId: string;
  humanoidName: string;
}

/**
 * WhatsAppAgentChat is the in-view "Ask the bot" dock for the WhatsApp client —
 * the WhatsApp analog of EmailAgentChat. You prompt the humanoid here; its draft
 * previews and "type send" prompts stream back into the humanoid's per-mode output
 * buffer. It reuses the same routing as the pane's humanoid-mode input
 * (submit_input with mode = humanoid name), so the draft → "send" flow behaves
 * identically to the terminal client.
 */
export const WhatsAppAgentChat = React.memo(function WhatsAppAgentChat({ paneId, humanoidName }: Props) {
  const output = useStore(
    (s) =>
      s.paneContent[paneId]?.modeOutputs?.[humanoidName] ??
      findPane(s.snapshot, paneId)?.mode_outputs?.[humanoidName] ??
      ''
  );
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

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
      <div className="px-2.5 py-1 text-[11px] font-bold text-[#87ffaf] border-b border-[#333] bg-[#1e1e1e] select-none shrink-0">
        Ask {humanoidName} — drafts &amp; replies
      </div>
      <PaneOutput paneId={paneId} output={output} />
      <div className="flex items-end gap-1 px-2 py-1.5 border-t border-[#333] bg-[#1a1a1a] shrink-0">
        <span className="text-[#5fafff] font-bold select-none leading-6">{'>'}</span>
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder="tell the bot what to reply… then type “send”"
          className="flex-1 resize-none bg-transparent border-none outline-none text-[#d4d4d4] font-mono text-[12px] leading-snug placeholder:text-[#555] max-h-32 overflow-y-auto break-words"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
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
