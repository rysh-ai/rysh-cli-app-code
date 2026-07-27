import React from 'react';
import type { WhatsAppMsgSummary } from '../types';

interface Props {
  messages: WhatsAppMsgSummary[] | undefined;
  loading: boolean;
  error?: string;
  selectedID: string | null;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}

/**
 * WhatsAppThreadList is the middle column of the WhatsApp client: the scrollable
 * list of recent received messages (newest first). Rows are summaries from the
 * store; clicking one opens it in the reading pane. The WhatsApp analog of
 * EmailThreadList.
 */
export const WhatsAppThreadList = React.memo(function WhatsAppThreadList({
  messages,
  loading,
  error,
  selectedID,
  onOpen,
  onRefresh,
}: Props) {
  return (
    <div className="w-[300px] shrink-0 border-r border-[#333] flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#333] bg-[#1e1e1e] shrink-0">
        <span className="text-[12px] font-bold text-[#d4d4d4]">
          Messages{messages ? ` (${messages.length})` : ''}
          {loading && messages && <span className="ml-1 text-[10px] font-normal text-[#666]">refreshing…</span>}
        </span>
        <button
          onClick={onRefresh}
          title="Refresh"
          className="text-[#87ffaf] hover:text-[#aeffc7] text-[14px] leading-none px-1"
        >
          ⟳
        </button>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {error ? (
          <div className="p-3 text-[12px] text-[#ff8787]">Error: {error}</div>
        ) : !messages ? (
          <div className="p-3 text-[12px] text-[#888]">Loading…</div>
        ) : messages.length === 0 ? (
          <div className="p-3 text-[12px] text-[#888]">No messages received yet.</div>
        ) : (
          messages.map((m) => {
            const selected = selectedID === m.id;
            return (
              <button
                key={m.id}
                onClick={() => onOpen(m.id)}
                className={`w-full text-left px-3 py-2 border-b border-[#262626] hover:bg-[#222] transition-colors ${
                  selected ? 'bg-[#16382a]' : ''
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-bold text-[#e0e0e0] truncate">
                    {m.name || m.from}
                  </span>
                  <span className="text-[10px] text-[#777] shrink-0">{m.time}</span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[10px] font-mono font-bold text-[#87ffaf] bg-[#16382a] rounded px-1 shrink-0" title="message id — mention it to the bot">
                    {m.id}
                  </span>
                  <span className="text-[11px] text-[#808080] truncate">{m.from}</span>
                </div>
                <div className="text-[12px] text-[#cfcfcf] truncate">{m.snippet}</div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
});
