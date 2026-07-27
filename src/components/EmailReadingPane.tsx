import React from 'react';
import type { EmailDetail } from '../types';

interface Props {
  detail: EmailDetail | undefined;
  selectedUID: number | null;
  onBack: () => void;
}

/**
 * EmailReadingPane is the right column of the email client: the full content of
 * the selected email. The body is rendered as React-escaped plain text — HTML
 * emails show as source with a notice (safe by default; sanitized rich rendering
 * is a planned follow-up, see docs/email-client/05-future-and-gaps.md).
 */
export const EmailReadingPane = React.memo(function EmailReadingPane({ detail, selectedUID, onBack }: Props) {
  if (selectedUID == null) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#555] text-[13px] select-none">
        Select an email to read
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#888] text-[13px] select-none">
        Loading email…
      </div>
    );
  }

  const looksHTML = /<\/?[a-z][\s\S]*>/i.test(detail.body);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2 border-b border-[#333] bg-[#1e1e1e] shrink-0">
        <div className="flex items-start justify-between gap-2">
          <div className="text-[14px] font-bold text-[#d4d4d4] break-words">
            {detail.subject || '(no subject)'}
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
        {detail.to && <div className="text-[11px] text-[#9a9a9a] break-words">To: {detail.to}</div>}
        {detail.date && <div className="text-[11px] text-[#777]">{detail.date}</div>}
        {detail.attachments && detail.attachments.length > 0 && (
          <div className="text-[11px] text-[#9a9a9a] mt-1">
            📎 {detail.attachments.map((a) => a.filename).join(', ')}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3">
        {looksHTML && (
          <div className="mb-2 text-[10px] text-[#caa14a] bg-[#2a2410] border border-[#574a1d] rounded px-2 py-1">
            HTML email — shown as source text (rich rendering coming soon)
          </div>
        )}
        <div className="text-[13px] text-[#cfcfcf] whitespace-pre-wrap break-words font-mono leading-relaxed">
          {detail.body}
        </div>
      </div>
    </div>
  );
});
