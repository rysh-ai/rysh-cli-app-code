import React from 'react';
import type { WhatsAppMsgDetail } from '../types';

interface Props {
  detail: WhatsAppMsgDetail | undefined;
  selectedID: string | null;
  onBack: () => void;
}

/**
 * WhatsAppReadingPane is the right-of-list column: the full text of the selected
 * received message. The WhatsApp analog of EmailReadingPane.
 */
export const WhatsAppReadingPane = React.memo(function WhatsAppReadingPane({ detail, selectedID, onBack }: Props) {
  if (selectedID == null) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#555] text-[13px] select-none">
        Select a message to read
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#888] text-[13px] select-none">
        Loading message…
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2 border-b border-[#333] bg-[#1e1e1e] shrink-0">
        <div className="flex items-start justify-between gap-2">
          <div className="text-[14px] font-bold text-[#d4d4d4] break-words">
            {detail.name || detail.from}
          </div>
          <button
            onClick={onBack}
            title="Close"
            className="text-[#888] hover:text-[#fff] text-[16px] leading-none px-1 shrink-0"
          >
            ×
          </button>
        </div>
        <div className="text-[11px] text-[#9a9a9a] mt-1 break-words">From: {detail.from}</div>
        {detail.time && <div className="text-[11px] text-[#777]">{detail.time}</div>}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3">
        <div className="text-[13px] text-[#cfcfcf] whitespace-pre-wrap break-words font-mono leading-relaxed">
          {detail.text}
        </div>
      </div>
    </div>
  );
});
