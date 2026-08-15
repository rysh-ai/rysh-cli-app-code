import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import type { BoardPost, BoardThread } from '../types';

interface Props {
  paneId: string;
  /** The pane's `board.id` meta, forwarded verbatim; the server resolves it. */
  boardId: string;
}

/**
 * AgentsBoardView renders an agents-board pane (design 025 §6, design 028).
 *
 * WHY THIS COMPONENT EXISTS. agents-board is a PaneType whose panes are
 * SHELL-LESS: no PTY, no VT screen, no output buffer. The terminal UI does not
 * need a view like this one because it builds the board itself from a store it
 * subscribes to (internal/tui/board_view.go). Every other client fell through
 * to `<PaneOutput output={pane.output}>` — and for a shell-less pane that field
 * holds whatever stale text was last written near it. Observed live: a board
 * pane in the desktop app showing an old `##pane list --meta` dump while four
 * agents posted to that board and every post arrived.
 *
 * So the failure was never a blank pane. It was PLAUSIBLE WRONG CONTENT, which
 * is why it read as "the board does not work" rather than as a missing feature.
 *
 * PULL, NOT PUSH. The board has no per-board change notification to forward, so
 * this polls `board_get` while the pane is mounted. That is a deliberate limit:
 * the alternative is a second copy of the board living in the web server, which
 * is the thing internal/web/board.go declines to build.
 */
export const AgentsBoardView = React.memo(function AgentsBoardView({ paneId, boardId }: Props) {
  const data = useStore((s) => s.boardData[paneId]);
  const setBoardData = useStore((s) => s.setBoardData);
  const [showRoster, setShowRoster] = useState(false);
  const [unanswered, setUnanswered] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Poll while mounted. The first fetch is immediate so opening the pane is not
  // a blank two seconds; PERIOD is a monitoring view's refresh, not a chat
  // client's — the board answers "what is happening now", and 2s is under the
  // time it takes to read one thread.
  useEffect(() => {
    let alive = true;
    const fetch = () => {
      if (!alive) return;
      sendCommand('board_get', {
        request_id: `${paneId}:${Date.now()}`,
        pane_id: paneId,
        board: boardId,
      });
    };
    fetch();
    const t = window.setInterval(fetch, 2000);
    // A DAEMON THAT NEVER ANSWERS MUST NOT LOOK LIKE A SLOW ONE. `board_get` is
    // newer than some daemons this renderer will connect to, and an unknown ws
    // action is silently ignored on the server — so without this the pane would
    // sit on "reading the board…" forever, which is the same silence-as-health
    // failure the rest of this view is built to avoid, committed by the client
    // this time.
    const noReply = window.setTimeout(() => {
      if (alive) setUnanswered(true);
    }, 10000);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.clearTimeout(noReply);
    };
  }, [paneId, boardId]);

  // A board pane that is closed and reopened must not show the previous
  // board's answer for an instant. Clearing on board change is cheap and makes
  // the "which fleet am I looking at" question unambiguous during the first
  // fetch.
  useEffect(() => {
    if (data && data.board && boardId && data.board !== boardId) {
      setBoardData({ paneId, board: boardId, fetchedAt: Date.now() });
    }
  }, [boardId, data, paneId, setBoardData]);

  // Stay pinned to the newest post unless the reader has scrolled up — the
  // same rule the TUI's board uses, and the reason scrollOffset exists there.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  // ── The three states, kept distinct on purpose ──
  //
  // "not asked yet", "asked and the recorder did not answer" and "answered, and
  // the board is empty" are three different facts about the world. Collapsing
  // any two of them reproduces the failure this whole path is built to avoid:
  // silence rendered as health (board.ErrNoRecorder, F-20, F-23).
  if (!data) {
    return (
      <BoardFrame boardId={boardId}>
        {unanswered ? (
          <div className="p-3 text-[12px]">
            <div className="text-[#ff8787] font-bold mb-1">the daemon never answered</div>
            <div className="text-[#808080]">
              No reply to <code className="text-[#87d7af]">board_get</code>. The most likely cause is
              a daemon older than that command — restart it to pick up a build that has it. This is
              NOT an empty board: nothing has been read.
            </div>
          </div>
        ) : (
          <div className="text-[#808080] text-[12px] p-3">reading the board…</div>
        )}
      </BoardFrame>
    );
  }

  if (data.error) {
    return (
      <BoardFrame boardId={boardId}>
        <div className="p-3 text-[12px]">
          <div className="text-[#ff8787] font-bold mb-1">
            {data.no_recorder ? 'the board recorder is not answering' : 'the board could not be read'}
          </div>
          <div className="text-[#c0c0c0] mb-2 break-words">{data.error}</div>
          <div className="text-[#808080]">
            {data.no_recorder
              ? 'This is NOT an empty board — the posts may be fine and unreadable from here. ' +
                'ABLA (the recorder) is one actor per session; if the daemon is up, check that it started.'
              : 'The request was refused rather than unanswered, which points at this client or the server hop.'}
          </div>
        </div>
      </BoardFrame>
    );
  }

  const threads = data.threads || [];
  const roster = data.roster || [];

  return (
    <BoardFrame
      boardId={data.board || boardId}
      stats={
        <>
          <button
            type="button"
            onClick={() => setShowRoster((v) => !v)}
            className="text-[#8a8aaf] hover:text-white cursor-pointer"
            title={
              data.roster_reconciled === false
                ? 'roster served as recorded — it may list panes that have since closed (F-26)'
                : 'roster checked against the panes that exist now'
            }
          >
            {roster.length} agent{roster.length === 1 ? '' : 's'}
            {data.roster_reconciled === false ? '?' : ''}
          </button>
          <span className="text-[#666]">·</span>
          <span>
            {data.stats?.threads ?? threads.length} thread
            {(data.stats?.threads ?? threads.length) === 1 ? '' : 's'}
          </span>
          {!!data.withheld && (
            <>
              <span className="text-[#666]">·</span>
              {/* Say what is NOT shown rather than present a window as the
                  whole board — the discipline design 025 §7.1a puts on
                  eviction, applied to the query's own limit. */}
              <span className="text-[#af8700]" title="older threads exist beyond this window">
                +{data.withheld} older
              </span>
            </>
          )}
        </>
      }
    >
      {showRoster && (
        <div className="px-3 py-2 border-b border-[#333] bg-[#1a1a1a] text-[11px]">
          {roster.length === 0 ? (
            <span className="text-[#808080]">no agent has announced itself on this board</span>
          ) : (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {roster.map((r) => (
                <span key={r.pane_id} className="text-[#87d7af]" title={r.pane_id}>
                  {r.persona}
                </span>
              ))}
            </div>
          )}
          {data.roster_reconciled === false && (
            <div className="text-[#af8700] mt-1">
              served as recorded — some of these panes may have closed
            </div>
          )}
        </div>
      )}

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        {threads.length === 0 ? (
          <div className="text-[#808080] text-[12px]">
            The recorder answered: this board is empty.
            <div className="mt-1 text-[#666]">
              Agents post to it with <code className="text-[#87d7af]">rysh board post &lt;text&gt;</code>.
            </div>
          </div>
        ) : (
          threads.map((t) => <Thread key={t.key} thread={t} />)
        )}
      </div>
    </BoardFrame>
  );
});

/** Chrome shared by every state, so the board id is visible even in failure. */
function BoardFrame({
  boardId,
  stats,
  children,
}: {
  boardId: string;
  stats?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[#1e1e1e]">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-[#333] bg-[#1a1a1a] text-[11px] shrink-0">
        <span className="text-[#af87ff] font-bold">board</span>
        <span className="text-[#d0d0d0]">{boardId || 'session'}</span>
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-[#808080]">{stats}</span>
      </div>
      {children}
    </div>
  );
}

function Thread({ thread }: { thread: BoardThread }) {
  const replies = thread.replies || [];
  return (
    <div className="mb-3">
      {thread.root ? (
        <Post post={thread.root} />
      ) : (
        // A provisional thread is EXPECTED, not an error: thread ids are minted
        // agent-side with no round trip (design 025 §4.3), so a reply can land
        // before its root. Saying so beats rendering a headless thread.
        <div className="text-[#af8700] text-[11px]">
          ⋯ replies whose root has not arrived yet
        </div>
      )}
      {replies.length > 0 && (
        <div className="ml-3 mt-1 border-l border-[#333] pl-3">
          {replies.map((r, i) => (
            <Post key={`${r.pane_id}-${r.ts}-${i}`} post={r} reply />
          ))}
        </div>
      )}
    </div>
  );
}

function Post({ post, reply }: { post: BoardPost; reply?: boolean }) {
  return (
    <div className={reply ? 'mb-1.5' : 'mb-1'}>
      <div className="flex items-baseline gap-1.5 text-[11px] flex-wrap">
        {!reply && <span className="text-[#87d7af]">●</span>}
        {/* title carries the pane id: persona is unique per LANE, not per
            session, so two agents can legitimately share this name and the id
            is the only way to tell them apart. */}
        <span className="text-[#87d7af] font-bold" title={post.pane_id}>
          {post.persona}
        </span>
        <span className="text-[#8a8aaf]">[{post.kind}]</span>
        {post.to_persona && <span className="text-[#af87ff]">→ {post.to_persona}</span>}
        <span className="text-[#666]">{formatTS(post.ts)}</span>
      </div>
      <div className="text-[#d0d0d0] text-[12px] whitespace-pre-wrap break-words leading-snug">
        {post.text}
      </div>
    </div>
  );
}

/**
 * The POSTER's clock, rendered as local wall time.
 *
 * Time-only, matching the TUI. The board is a live monitoring view, and the
 * honest limit on this field (arrival order, not causal order — see
 * msg.MsgBoardPost.TS) makes a precise-looking full timestamp a slightly
 * dishonest one.
 */
function formatTS(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
