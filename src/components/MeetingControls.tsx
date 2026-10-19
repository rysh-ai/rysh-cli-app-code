import { useCallback, useEffect, useState } from 'react';
import { panelVerbs, sendMeetingCommand, validMeetingId, type MeetingBotReply, type MeetingVerb } from '../meeting/controls';

// Meeting-bot lifecycle panel (E17 k2, MTG-6, design 040), under a meeting
// pane's view (mounted beside MeetingPaneView in PaneBox, which stays E30's).
// It reads the meeting's pending turn every few seconds and offers the
// design-040 controls the bot's state allows — approve/reject, speak,
// pause/resume, cancel — each addressed to THIS pane's meeting id. The
// meeting id, agents and leave live in E30's pane header; not repeated here.

const POLL_MS = 3000;
const LABELS: Record<MeetingVerb, string> = {
  pending: 'Refresh',
  approve: 'Approve',
  reject: 'Reject',
  speak: 'Speak',
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
};

export function MeetingControls({ paneId, meetingId }: { paneId: string; meetingId: string | undefined }) {
  const [reply, setReply] = useState<MeetingBotReply | undefined>();
  const [note, setNote] = useState('');
  const valid = validMeetingId(meetingId);

  const refresh = useCallback(() => {
    if (!valid) return;
    sendMeetingCommand(meetingId, 'pending').then(setReply, (e: Error) => setNote(`pending: ${e.message}`));
  }, [valid, meetingId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (!valid) {
    return (
      <div className="px-2.5 py-1 border-t border-[#333] text-[11px] text-[#888]" data-pane={paneId}>
        bot controls: this pane has no meeting id
      </div>
    );
  }

  const act = (verb: MeetingVerb) => {
    setNote(`${verb}…`);
    sendMeetingCommand(meetingId, verb, reply?.turn_id).then(
      (r) => {
        setNote(`${verb}: ${r.state || 'ok'}${r.notice ? ` — ${r.notice}` : ''}`);
        refresh();
      },
      (e: Error) => setNote(`${verb} failed: ${e.message}`)
    );
  };

  const head = reply
    ? [reply.state, reply.phase && reply.phase !== reply.state ? reply.phase : '', reply.mode].filter(Boolean).join(' · ')
    : 'waiting for status…';

  return (
    <div
      className="flex flex-col gap-1 px-2.5 py-1.5 border-t border-[#333] bg-[#0f1424] text-[11px] text-[#cbd5e1] shrink-0"
      data-pane={paneId}
      aria-label="meeting bot controls"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[#888]">bot</span>
        <span>{head}</span>
        <span className="ml-auto flex gap-1">
          {panelVerbs(reply).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => act(v)}
              className={`px-2 rounded border border-[#475569] hover:bg-[#1e293b] ${v === 'approve' || v === 'speak' ? 'bg-[#14532d]' : ''}`}
            >
              {LABELS[v]}
            </button>
          ))}
          <button type="button" onClick={refresh} className="px-2 rounded border border-[#475569] hover:bg-[#1e293b]">
            {LABELS.pending}
          </button>
        </span>
      </div>
      {reply?.turn_id && (
        <div className="truncate">
          turn <span className="font-mono">{reply.turn_id}</span>
          {reply.speaker && ` · ${reply.speaker} → ${reply.agent || 'rysh'}`}
          {reply.request && <span className="text-[#94a3b8]"> · {reply.request}</span>}
        </div>
      )}
      {note && (
        <div role={note.includes('failed') ? 'alert' : undefined} className={note.includes('failed') ? 'text-[#f87171]' : 'text-[#94a3b8]'}>
          {note}
        </div>
      )}
    </div>
  );
}
