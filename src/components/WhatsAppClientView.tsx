import React, { useEffect, useCallback } from 'react';
import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import { WhatsAppThreadList } from './WhatsAppThreadList';
import { WhatsAppReadingPane } from './WhatsAppReadingPane';
import { WhatsAppAgentChat } from './WhatsAppAgentChat';

interface Props {
  paneId: string;
  humanoidName: string;
}

/**
 * WhatsAppClientView is the desktop three-pane view for a pane in a WhatsApp
 * humanoid's mode (rail → message list → reading pane → AI dock). It mirrors
 * EmailClientView, sourcing data from the store keyed by humanoid name with
 * per-pane view selection. Replies are steered by the AI: prompt the bot in the
 * dock (draft → "send"), exactly as in the terminal client.
 */
export const WhatsAppClientView = React.memo(function WhatsAppClientView({ paneId, humanoidName }: Props) {
  const messages = useStore((s) => s.whatsappList[humanoidName]);
  const loading = useStore((s) => s.whatsappLoading[humanoidName]);
  const error = useStore((s) => s.whatsappError[humanoidName]);
  const selectedID = useStore((s) => s.whatsappSelectedID[paneId] ?? null);
  const detail = useStore((s) =>
    selectedID != null ? s.whatsappDetails[humanoidName]?.[selectedID] : undefined
  );
  const setLoading = useStore((s) => s.setWhatsAppLoading);
  const setSelectedID = useStore((s) => s.setWhatsAppSelectedID);
  const chatOpen = useStore((s) => s.whatsappChatOpen[paneId] !== false);
  const setChatOpen = useStore((s) => s.setWhatsAppChatOpen);

  // Fetch the listing the first time the view mounts for a humanoid we haven't
  // listed yet this session. `messages === undefined` means "never fetched".
  useEffect(() => {
    if (messages === undefined) {
      setLoading(humanoidName, true);
      sendCommand('whatsapp_list', { humanoid_name: humanoidName });
    }
  }, [humanoidName, messages, setLoading]);

  // Tell the bot which message is open (focus) once its detail loads, so "reply
  // to this" acts on the selected message — even an older one.
  useEffect(() => {
    if (selectedID != null && detail && detail.id === selectedID) {
      sendCommand('whatsapp_focus', {
        humanoid_name: humanoidName,
        listing: false,
        id: detail.id,
        from: detail.from,
        body: detail.text,
      });
    }
  }, [humanoidName, selectedID, detail]);

  const refresh = useCallback(() => {
    setLoading(humanoidName, true);
    sendCommand('whatsapp_refresh', { humanoid_name: humanoidName });
  }, [humanoidName, setLoading]);

  const openMessage = useCallback(
    (id: string) => {
      setSelectedID(paneId, id);
      sendCommand('whatsapp_read', { humanoid_name: humanoidName, id });
    },
    [paneId, humanoidName, setSelectedID]
  );

  const backToList = useCallback(() => {
    setSelectedID(paneId, null);
    sendCommand('whatsapp_focus', { humanoid_name: humanoidName, listing: true });
  }, [paneId, humanoidName, setSelectedID]);

  return (
    <div className="flex flex-1 min-h-0 bg-[#1a1a1a]">
      {/* Rail */}
      <div className="w-[130px] shrink-0 border-r border-[#333] bg-[#171717] flex flex-col py-2">
        <div className="px-3 py-1 text-[11px] font-bold text-[#aff5c7] uppercase tracking-wide">
          WhatsApp
        </div>
        <div className="px-3 py-1.5 text-[12px] text-[#87ffaf] bg-[#1e1e1e]">Messages</div>
        <button
          onClick={() => setChatOpen(paneId, !chatOpen)}
          title={chatOpen ? 'Hide the bot panel' : 'Ask the bot'}
          className={`mt-auto mx-2 mb-1 px-2 py-1 rounded text-[11px] text-center transition-colors ${
            chatOpen ? 'bg-[#16382a] text-[#87ffaf]' : 'bg-[#262626] text-[#9a9a9a] hover:bg-[#2e2e2e]'
          }`}
        >
          {chatOpen ? '✕ Hide bot' : '💬 Ask bot'}
        </button>
        <div className="px-3 py-1 text-[10px] text-[#555] truncate" title={humanoidName}>
          {humanoidName}
        </div>
      </div>

      <WhatsAppThreadList
        messages={messages}
        loading={!!loading}
        error={error}
        selectedID={selectedID}
        onOpen={openMessage}
        onRefresh={refresh}
      />

      <WhatsAppReadingPane detail={detail} selectedID={selectedID} onBack={backToList} />

      {chatOpen && <WhatsAppAgentChat paneId={paneId} humanoidName={humanoidName} />}
    </div>
  );
});
