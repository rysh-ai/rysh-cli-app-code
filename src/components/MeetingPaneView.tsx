import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { WebPaneView } from './WebPaneView';
import { requestMeetingToken } from '../meeting/daemonToken';
import type { JoinGrant } from '../meeting/join';
import {
  canOpenMeetingReport,
  leaveMeeting,
  meetingInfo,
  openMeetingReport,
  safeMeetingUrl,
  validMeetingId,
  type MeetingPaneInfo,
} from '../meeting/paneMeta';

// LiveKit's React layer is only needed by livekit meeting panes; load it on
// demand, as Header does for the meeting dialog.
const MeetingRoom = lazy(() => import('./MeetingPanel').then((m) => ({ default: m.MeetingRoom })));

// A meeting pane (design 043, Decision 1): one pane type, two renderers.
//
//  - kind "web"     — Meet / Zoom / Teams in the desktop app's own browser
//                     engine: the SAME WebContentsView machinery and profile
//                     partition as web mode (WebPaneView), created as a meeting
//                     view so the page gets camera, mic and screen share.
//  - kind "livekit" — a rysh room: MeetingRoom (LK-4) inside the pane, with a
//                     join token the daemon mints on request (daemonToken.ts).
//
// The pane is the human, on their own account and profile; agents join as a
// separate bot participant (Decision 2), which the header reports.

const BOT_LABELS: Record<string, string> = {
  joining: 'bot joining',
  in_call: 'bot in call',
  left: 'bot left',
  failed: 'bot failed',
};

export const MeetingPaneView = React.memo(function MeetingPaneView({
  paneId,
  meta,
}: {
  paneId: string;
  meta: Record<string, string> | undefined;
}) {
  const info = meetingInfo(meta);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <MeetingHeader paneId={paneId} info={info} />
      <MeetingBody paneId={paneId} info={info} />
    </div>
  );
});

export function MeetingHeader({ paneId, info }: { paneId: string; info: MeetingPaneInfo }) {
  // Several agent bots (design 043 D9): one chip per bot instead of the
  // aggregate badge.
  const perBot = info.bots.length > 1;
  const botLabel = perBot ? undefined : BOT_LABELS[info.bot];
  // The reporter's report.md (E-81), once the daemon has written one.
  const showReport = !!info.report && validMeetingId(info.id) && canOpenMeetingReport();
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1 border-b border-[#333] bg-[#141b2f] text-[11px] text-[#cbd5e1] shrink-0 select-none"
      aria-label="Meeting"
    >
      <span className="font-mono text-[#87d7ff]" title="meeting id">
        {info.id || 'meeting'}
      </span>
      {info.platform && <span className="px-1 rounded border border-[#475569]">{info.platform}</span>}
      {perBot ? (
        <span className="flex items-center gap-1 truncate" title="one bot per agent">
          {info.bots.map((b) => (
            <span
              key={b.agent}
              data-testid="meeting-agent-bot"
              className={`px-1 rounded ${b.phase === 'failed' ? 'bg-[#5f0000] text-[#ff8787]' : 'bg-[#1e293b]'}`}
            >
              {b.agent}: {(BOT_LABELS[b.phase] || b.phase || 'idle').replace(/^bot /, '')}
            </span>
          ))}
        </span>
      ) : (
        <span className="truncate" title="agents in this meeting">
          {info.agents.length > 0 ? `agents: ${info.agents.join(', ')}` : 'no agents'}
        </span>
      )}
      {info.reporter && (
        // The silent reporter (design 045) is never addressed — it listens and
        // writes a report when the meeting ends, so it gets its own chip.
        <span
          data-testid="meeting-reporter"
          title={info.report ? `newest report: ${info.report}` : 'writes a report when the meeting ends'}
          className={`px-1 rounded ${info.reporter === 'failed' ? 'bg-[#5f0000] text-[#ff8787]' : 'bg-[#1e293b]'}`}
        >
          reporter: {(BOT_LABELS[info.reporter] || info.reporter).replace(/^bot /, '')}
        </span>
      )}
      {botLabel && (
        <span
          data-testid="meeting-bot"
          className={`px-1 rounded ${info.bot === 'failed' ? 'bg-[#5f0000] text-[#ff8787]' : 'bg-[#1e293b]'}`}
        >
          {botLabel}
        </span>
      )}
      {showReport && (
        <button
          type="button"
          title={`Open the meeting report (${info.report})`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            openMeetingReport(info.id, info.report);
          }}
          className="ml-auto px-2 rounded border border-[#475569] hover:bg-[#1e293b]"
        >
          Report
        </button>
      )}
      <button
        type="button"
        disabled={!validMeetingId(info.id)}
        title={`Leave the meeting and close this pane (##meeting leave ${info.id})`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          leaveMeeting(paneId, info.id);
        }}
        className={`${showReport ? '' : 'ml-auto '}px-2 rounded bg-[#b91c1c] hover:bg-[#dc2626] text-white disabled:opacity-40`}
      >
        Leave
      </button>
    </div>
  );
}

function MeetingBody({ paneId, info }: { paneId: string; info: MeetingPaneInfo }) {
  if (info.kind === 'web') {
    const url = safeMeetingUrl(info.url);
    if (!url) return <Notice>This meeting pane has no valid meeting link.</Notice>;
    return <WebPaneView paneId={paneId} meeting={{ url, profile: info.profile }} />;
  }
  if (info.kind === 'livekit') return <LiveKitMeeting paneId={paneId} room={info.room} />;
  return <Notice>Unknown meeting kind — this app may be older than the rysh daemon.</Notice>;
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 flex items-center justify-center p-5 text-center text-sm text-[#888]">{children}</div>;
}

type LiveKitState =
  | { phase: 'asking' }
  | { phase: 'in'; grant: JoinGrant }
  | { phase: 'out'; message: string; failed: boolean };

/**
 * The rysh room, joined with a token the daemon mints for this pane. Asked for
 * on every mount and every rejoin — the grant lives only in this state.
 */
export function LiveKitMeeting({ paneId, room }: { paneId: string; room: string }) {
  const [state, setState] = useState<LiveKitState>({ phase: 'asking' });
  const [attempt, setAttempt] = useState(0);
  const rejoin = useCallback(() => {
    setState({ phase: 'asking' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let live = true;
    requestMeetingToken(paneId, room || undefined).then(
      (grant) => live && setState({ phase: 'in', grant }),
      (e: Error) => live && setState({ phase: 'out', message: e.message, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [paneId, room, attempt]);

  if (state.phase === 'asking') return <Notice>Getting a join token from the rysh daemon…</Notice>;
  if (state.phase === 'out') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-5 text-sm text-[#aaa]">
        <p role={state.failed ? 'alert' : undefined} className={state.failed ? 'text-[#f87171]' : ''}>
          {state.message}
        </p>
        <button type="button" onClick={rejoin} className="px-3 py-1 rounded bg-[#2563eb] text-white">
          {state.failed ? 'Try again' : 'Rejoin'}
        </button>
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3">
      <Suspense fallback={<Notice>Loading the meeting…</Notice>}>
        <MeetingRoom
          grant={state.grant}
          onLeave={(reason) => setState({ phase: 'out', message: reason, failed: false })}
        />
      </Suspense>
    </div>
  );
}
