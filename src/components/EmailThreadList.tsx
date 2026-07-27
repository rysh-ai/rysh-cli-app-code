import React from 'react';
import type { EmailSummary } from '../types';

interface Props {
  emails: EmailSummary[] | undefined;
  loading: boolean;
  error?: string;
  selectedUID: number | null;
  onOpen: (uid: number) => void;
  onRefresh: () => void;
}

// senderName extracts a friendly display name from an RFC822 From header:
//   "Alice <a@x.com>" → "Alice"; bare "a@x.com" → "a@x.com".
function senderName(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<.+>\s*$/);
  const name = (m ? m[1] : from).trim();
  return name || from;
}

// shortDate trims the verbose RFC822 date to something compact. Best-effort: if
// it doesn't parse, show the raw value.
function shortDate(date: string): string {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return date;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * EmailThreadList is the middle column of the Gmail-style email client: the
 * scrollable inbox listing. Rows are summaries from the store; clicking one opens
 * it in the reading pane. Steering (replies) still happens through the pane's
 * humanoid input field — this column is read/navigate only.
 */
export const EmailThreadList = React.memo(function EmailThreadList({
  emails,
  loading,
  error,
  selectedUID,
  onOpen,
  onRefresh,
}: Props) {
  return (
    <div className="w-[300px] shrink-0 border-r border-[#333] flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#333] bg-[#1e1e1e] shrink-0">
        <span className="text-[12px] font-bold text-[#d4d4d4]">
          Inbox{emails ? ` (${emails.length})` : ''}
          {loading && emails && <span className="ml-1 text-[10px] font-normal text-[#666]">refreshing…</span>}
        </span>
        <button
          onClick={onRefresh}
          title="Refresh"
          className="text-[#87ffff] hover:text-[#aeffff] text-[14px] leading-none px-1"
        >
          ⟳
        </button>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {error ? (
          <div className="p-3 text-[12px] text-[#ff8787]">Error: {error}</div>
        ) : !emails ? (
          <div className="p-3 text-[12px] text-[#888]">Loading…</div>
        ) : emails.length === 0 ? (
          <div className="p-3 text-[12px] text-[#888]">No emails in this inbox.</div>
        ) : (
          emails.map((e) => {
            const selected = selectedUID === e.uid;
            return (
              <button
                key={e.uid}
                onClick={() => onOpen(e.uid)}
                className={`w-full text-left px-3 py-2 border-b border-[#262626] hover:bg-[#222] transition-colors ${
                  selected ? 'bg-[#16383a]' : ''
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-bold text-[#e0e0e0] truncate">
                    {senderName(e.from)}
                  </span>
                  <span className="text-[10px] text-[#777] shrink-0">{shortDate(e.date)}</span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[10px] font-mono font-bold text-[#87ffff] bg-[#16383a] rounded px-1 shrink-0" title="email id — mention it to the bot">
                    {e.id}
                  </span>
                  <span className="text-[12px] text-[#cfcfcf] truncate">{e.subject || '(no subject)'}</span>
                </div>
                <div className="text-[11px] text-[#808080] truncate">{e.snippet}</div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
});
