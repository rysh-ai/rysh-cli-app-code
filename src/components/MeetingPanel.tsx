import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DisconnectButton,
  LiveKitRoom,
  RoomAudioRenderer,
  TrackToggle,
  useDataChannel,
  useParticipants,
} from '@livekit/components-react';
import { ParticipantKind, Track, type Participant } from 'livekit-client';
import { checkGrant, parseJoinLink, validRoom, type JoinGrant, type TokenSource } from '../meeting/join';
import {
  WALL_LABELS,
  WALL_TOPIC,
  TURN_PHASES,
  formatElapsed,
  parseWall,
  wallDetail,
  type WallStatus,
} from '../meeting/wall';

// Rysh-native meeting panel (design 042, LK-4): joins a LiveKit room, lists
// the participants (the rysh bot included), gives mic/speaker controls, and
// shows the bot's progress wall from its "rysh.wall" data channel.

/**
 * The rysh bot (or another rysh agent) in the room. Both signals come from the
 * token rysh-server mints (LK-3): participant kind AGENT and the attribute
 * rysh.kind=agent. Account tokens do not grant canUpdateOwnMetadata, so a
 * person cannot set that attribute on themselves and impersonate the bot.
 */
export function isAgent(p: Pick<Participant, 'kind' | 'attributes'>): boolean {
  return p.kind === ParticipantKind.AGENT || p.attributes?.['rysh.kind'] === 'agent';
}

export function MeetingPanel({ onClose, tokenSource }: { onClose: () => void; tokenSource?: TokenSource }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [grant, setGrant] = useState<JoinGrant>();
  const [notice, setNotice] = useState('');

  useEffect(() => {
    dialog.current?.showModal?.();
    window.electronAPI?.webPane?.setSuppressed?.(true);
    return () => {
      void window.electronAPI?.webPane?.setSuppressed?.(false);
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="meeting-title"
      className="w-[760px] max-w-[95vw] max-h-[90vh] bg-[#202020] text-[#eee] border border-[#555] rounded-lg p-5 backdrop:bg-black/60"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <div className="flex justify-between mb-4">
        <h2 id="meeting-title" className="text-lg">
          Rysh meeting{grant?.room ? ` — ${grant.room}` : ''}
        </h2>
        <button onClick={onClose} className="px-2 rounded bg-[#333] hover:bg-[#444]" aria-label="Close meeting panel">
          ✕
        </button>
      </div>
      {grant ? (
        <MeetingRoom
          grant={grant}
          onLeave={(reason) => {
            setGrant(undefined);
            setNotice(reason);
          }}
        />
      ) : (
        <JoinForm tokenSource={tokenSource} notice={notice} onJoin={setGrant} />
      )}
    </dialog>,
    document.body,
  );
}

export function JoinForm({
  tokenSource,
  notice,
  onJoin,
}: {
  tokenSource?: TokenSource;
  notice?: string;
  onJoin: (g: JoinGrant) => void;
}) {
  const [link, setLink] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [room, setRoom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function fromLink() {
    setError('');
    try {
      onJoin(link.trim() ? parseJoinLink(link) : checkGrant({ url: url.trim(), token }));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function fromServer() {
    if (!tokenSource || busy) return;
    setError('');
    setBusy(true);
    try {
      onJoin({ room, ...(await tokenSource(room)) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      {notice && <p className="text-[#aaa]">{notice}</p>}
      {tokenSource && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void fromServer();
          }}
        >
          <label className="text-[#aaa]" htmlFor="meeting-room">
            Room id (token from your rysh account)
          </label>
          <div className="flex gap-2">
            <input
              id="meeting-room"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="standup"
              className="flex-1 bg-[#111] border border-[#555] rounded px-2 py-1"
            />
            <button type="submit" disabled={busy || !validRoom(room)} className="px-3 rounded bg-[#2563eb] disabled:opacity-40">
              {busy ? 'Joining…' : 'Join'}
            </button>
          </div>
        </form>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          fromLink();
        }}
      >
        <label className="text-[#aaa]" htmlFor="meeting-link">
          Join link (from <code>rysh meeting host</code>)
        </label>
        <input
          id="meeting-link"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://…?url=wss://…&token=…"
          className="bg-[#111] border border-[#555] rounded px-2 py-1"
        />
        <details className="text-[#aaa]">
          <summary className="cursor-pointer">Or server URL and token</summary>
          <div className="flex flex-col gap-2 mt-2">
            <input
              aria-label="LiveKit server URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ws://localhost:7880"
              className="bg-[#111] border border-[#555] rounded px-2 py-1 text-[#eee]"
            />
            <input
              aria-label="Join token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="join token"
              className="bg-[#111] border border-[#555] rounded px-2 py-1 text-[#eee]"
            />
          </div>
        </details>
        <button
          type="submit"
          disabled={!link.trim() && !(url.trim() && token.trim())}
          className="self-start px-3 py-1 rounded bg-[#2563eb] disabled:opacity-40"
        >
          Join
        </button>
      </form>
      {error && (
        <p role="alert" className="text-[#f87171]">
          {error}
        </p>
      )}
      <p className="text-[11px] text-[#888]">
        Rysh meetings may include AI participants. The rysh bot hears what is said in the room and speaks with an
        AI-generated voice.
      </p>
    </div>
  );
}

export function MeetingRoom({ grant, onLeave }: { grant: JoinGrant; onLeave: (reason: string) => void }) {
  const [speakerOn, setSpeakerOn] = useState(true);
  return (
    <LiveKitRoom
      serverUrl={grant.url}
      token={grant.token}
      connect
      audio={false}
      video={false}
      onDisconnected={() => onLeave('You left the meeting.')}
      onError={(e) => onLeave(`Disconnected: ${e.message}`)}
      className="flex flex-col gap-4 text-sm"
    >
      <RoomAudioRenderer muted={!speakerOn} />
      <BotWall />
      <ParticipantList />
      <div className="flex gap-2 items-center">
        <TrackToggle source={Track.Source.Microphone} className="px-3 py-1 rounded bg-[#333] hover:bg-[#444]">
          Mic
        </TrackToggle>
        <button
          onClick={() => setSpeakerOn((v) => !v)}
          aria-pressed={speakerOn}
          className="px-3 py-1 rounded bg-[#333] hover:bg-[#444]"
        >
          {speakerOn ? 'Speaker on' : 'Speaker off'}
        </button>
        <DisconnectButton className="ml-auto px-3 py-1 rounded bg-[#b91c1c] hover:bg-[#dc2626]">Leave</DisconnectButton>
      </div>
    </LiveKitRoom>
  );
}

export function ParticipantList() {
  const participants = useParticipants();
  return (
    <ul aria-label="Participants" className="flex flex-col gap-1">
      {participants.map((p) => (
        <li key={p.identity} className="flex items-center gap-2">
          <span
            aria-hidden
            className={`w-2 h-2 rounded-full ${p.isSpeaking ? 'bg-[#34d399]' : 'bg-[#555]'}`}
          />
          <span>{p.name || p.identity}</span>
          {p.isLocal && <span className="text-[#888]">(you)</span>}
          {isAgent(p) && <span className="text-[10px] px-1 rounded border border-[#a78bfa] text-[#a78bfa]">AI</span>}
          {!p.isMicrophoneEnabled && <span className="text-[#888] text-[11px]">muted</span>}
        </li>
      ))}
    </ul>
  );
}

/** One bot's latest wall message and when its current turn started. */
interface BotStatus {
  status: WallStatus;
  turnStart?: number;
}

/**
 * The bots' progress, from their "rysh.wall" data messages: one wall per agent
 * participant, keyed by the sender's identity, since every agent is its own
 * bot (design 043 D9) and two bots must not overwrite each other's wall.
 */
export function BotWall() {
  const participants = useParticipants();
  const [walls, setWalls] = useState<ReadonlyMap<string, BotStatus>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  const onMessage = useCallback((msg: { payload: Uint8Array; from?: Participant }) => {
    const from = msg.from;
    if (!from || !isAgent(from)) return; // only a bot may drive a wall
    const status = parseWall(msg.payload);
    if (!status) return;
    const turnStart =
      TURN_PHASES.has(status.phase) && status.elapsedMs !== undefined ? Date.now() - status.elapsedMs : undefined;
    setWalls((prev) => new Map(prev).set(from.identity, { status, turnStart }));
  }, []);
  useDataChannel(WALL_TOPIC, onMessage);

  const ticking = [...walls.values()].some((w) => w.turnStart !== undefined);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [ticking]);

  // One wall per bot in the room, in room order: a bot that left (remove
  // agent) takes its wall with it.
  const bots = participants.filter(isAgent);
  if (bots.length === 0) {
    return (
      <section aria-label="Rysh bot" className="rounded-lg bg-[#141b2f] p-4 text-[#94a3b8]">
        Waiting for the rysh bot to join
      </section>
    );
  }
  return (
    <div className={bots.length > 1 ? 'grid grid-cols-2 gap-2' : 'flex flex-col'}>
      {bots.map((p) => (
        <Wall key={p.identity} name={p.name || p.identity} wall={walls.get(p.identity)} now={now} />
      ))}
    </div>
  );
}

function Wall({ name, wall, now }: { name: string; wall?: BotStatus; now: number }) {
  if (!wall) {
    return (
      <section aria-label={`Rysh bot ${name}`} className="rounded-lg bg-[#141b2f] p-4 text-[#94a3b8]">
        {`${name} is in the room`}
      </section>
    );
  }
  const { status, turnStart } = wall;
  const [label] = WALL_LABELS[status.phase];
  const inTurn = TURN_PHASES.has(status.phase) && !!(status.speaker || status.request);
  return (
    <section
      aria-label={`Rysh bot ${name}`}
      data-phase={status.phase}
      className="rounded-lg bg-[#141b2f] p-4 flex flex-col gap-2"
    >
      <div className="text-[11px] text-[#a78bfa]">{name}</div>
      <div className="text-2xl font-bold">{label}</div>
      <div className="text-[#94a3b8]">{wallDetail(status)}</div>
      {inTurn && (
        <div className="border-l-4 border-[#a78bfa] pl-3">
          <div className="flex justify-between text-[#94a3b8]">
            <span>
              Answering <b className="text-[#eee]">{status.speaker || 'the room'}</b>
            </span>
            {turnStart !== undefined && <span data-testid="wall-elapsed">{formatElapsed(now - turnStart)}</span>}
          </div>
          {status.request && <div>“{status.request}”</div>}
        </div>
      )}
      {status.caption && <p className="text-base font-semibold">{status.caption}</p>}
    </section>
  );
}
