import React, { useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import { EmailThreadList } from './EmailThreadList';
import { EmailReadingPane } from './EmailReadingPane';
import { EmailAgentChat } from './EmailAgentChat';

interface Props {
  paneId: string;
  humanoidName: string;
}

/**
 * EmailClientView is the desktop-only Gmail-style view for a pane in an email
 * humanoid's mode (folder rail → thread list → reading pane). It mirrors the
 * web-pane pattern (WebPaneView): PaneBox swaps it in for the content area, and
 * it sources its data from the store keyed by humanoid name (the email account),
 * with per-pane view selection.
 *
 * Replies are still steered by the AI: the user prompts the bot via the pane's
 * humanoid input field below (draft → "send"), exactly as in the terminal
 * client. A dedicated in-view AI dock is a later phase.
 */
export const EmailClientView = React.memo(function EmailClientView({ paneId, humanoidName }: Props) {
  const emails = useStore((s) => s.emailList[humanoidName]);
  const loading = useStore((s) => s.emailLoading[humanoidName]);
  const error = useStore((s) => s.emailError[humanoidName]);
  const selectedUID = useStore((s) => s.emailSelectedUID[paneId] ?? null);
  const detail = useStore((s) =>
    selectedUID != null ? s.emailDetails[humanoidName]?.[selectedUID] : undefined
  );
  const setEmailLoading = useStore((s) => s.setEmailLoading);
  const setEmailSelectedUID = useStore((s) => s.setEmailSelectedUID);
  const chatOpen = useStore((s) => s.emailChatOpen[paneId] !== false);
  const setEmailChatOpen = useStore((s) => s.setEmailChatOpen);

  // Fetch the inbox the first time the view mounts for a humanoid we haven't
  // listed yet this session. `emails === undefined` means "never fetched".
  useEffect(() => {
    if (emails === undefined) {
      setEmailLoading(humanoidName, true);
      sendCommand('email_list', { humanoid_name: humanoidName });
    }
  }, [humanoidName, emails, setEmailLoading]);

  // Tell the bot which email is open (focus) once its detail loads, so an AI
  // prompt ("reply to this") acts on the email the user is viewing — even an
  // older one. Sent on detail arrival so the body is included; returning to the
  // list sends listing=true from backToList instead.
  useEffect(() => {
    if (selectedUID != null && detail && detail.uid === selectedUID) {
      sendCommand('email_focus', {
        humanoid_name: humanoidName,
        listing: false,
        uid: detail.uid,
        message_id: detail.message_id,
        thread_id: detail.message_id,
        from: detail.from,
        subject: detail.subject,
        body: detail.body,
      });
    }
  }, [humanoidName, selectedUID, detail]);

  const refresh = useCallback(() => {
    setEmailLoading(humanoidName, true);
    sendCommand('email_refresh', { humanoid_name: humanoidName });
  }, [humanoidName, setEmailLoading]);

  const openEmail = useCallback(
    (uid: number) => {
      setEmailSelectedUID(paneId, uid);
      sendCommand('email_read', { humanoid_name: humanoidName, uid });
    },
    [paneId, humanoidName, setEmailSelectedUID]
  );

  const backToList = useCallback(() => {
    setEmailSelectedUID(paneId, null);
    sendCommand('email_focus', { humanoid_name: humanoidName, listing: true });
  }, [paneId, humanoidName, setEmailSelectedUID]);

  return (
    <div className="flex flex-1 min-h-0 bg-[#1a1a1a]">
      {/* Folder rail (Inbox only for now; Drafts/Sent are future). */}
      <div className="w-[130px] shrink-0 border-r border-[#333] bg-[#171717] flex flex-col py-2">
        <div className="px-3 py-1 text-[11px] font-bold text-[#ffffaf] uppercase tracking-wide">
          Mail
        </div>
        <div className="px-3 py-1.5 text-[12px] text-[#87ffff] bg-[#1e1e1e]">Inbox</div>
        <div className="px-3 py-1.5 text-[12px] text-[#5a5a5a] cursor-default" title="coming soon">
          Drafts
        </div>
        <div className="px-3 py-1.5 text-[12px] text-[#5a5a5a] cursor-default" title="coming soon">
          Sent
        </div>
        <button
          onClick={() => setEmailChatOpen(paneId, !chatOpen)}
          title={chatOpen ? 'Hide the bot panel' : 'Ask the bot'}
          className={`mt-auto mx-2 mb-1 px-2 py-1 rounded text-[11px] text-center transition-colors ${
            chatOpen ? 'bg-[#16383a] text-[#87ffff]' : 'bg-[#262626] text-[#9a9a9a] hover:bg-[#2e2e2e]'
          }`}
        >
          {chatOpen ? '✕ Hide bot' : '💬 Ask bot'}
        </button>
        <div className="px-3 py-1 text-[10px] text-[#555] truncate" title={humanoidName}>
          {humanoidName}
        </div>
      </div>

      <EmailThreadList
        emails={emails}
        loading={!!loading}
        error={error}
        selectedUID={selectedUID}
        onOpen={openEmail}
        onRefresh={refresh}
      />

      <EmailReadingPane detail={detail} selectedUID={selectedUID} onBack={backToList} />

      {chatOpen && <EmailAgentChat paneId={paneId} humanoidName={humanoidName} />}
    </div>
  );
});
