import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import { checkGrant, validRoom, type JoinGrant, type TokenSource } from './join';

// Join tokens for a rysh room shown in a meeting pane (design 043, Decision 5).
//
// The daemon holds the rysh key, so the app asks IT for a fresh participant
// token whenever a livekit meeting pane mounts:
//
//   → {type:"command", data:{action:"meeting_token", params:{pane_id}}}
//   ← {type:"meeting_token", data:{pane_id, url, token, identity, expires_at}}
//   ← {type:"meeting_token", data:{pane_id, error}}
//
// The daemon resolves the room from the pane's registry entry, never from this
// client, which is why the request carries only the pane id. The token lives
// in the promise's result and the component state that renders the room —
// never the zustand store, localStorage, pane meta or a log line.
//
// The header's Meeting panel has no pane (E-87): it names a room on the
// session's rysh server instead, and the daemon mints the token with the same
// key and server it uses for panes. The reply echoes the room:
//
//   → {type:"command", data:{action:"meeting_token", params:{room}}}
//   ← {type:"meeting_token", data:{pane_id:"", room, url, token, identity, expires_at}}

export const MEETING_TOKEN_ACTION = 'meeting_token';
const TIMEOUT_MS = 15000;

interface Pending {
  resolve: (g: JoinGrant) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// One in-flight request per pane (or per room, keyed "room:<id>"): a remount
// while waiting shares the answer.
const pending = new Map<string, { promise: Promise<JoinGrant>; entry: Pending }>();

export interface MeetingTokenReply {
  pane_id?: string;
  room?: string;
  url?: string;
  token?: string;
  identity?: string;
  expires_at?: string;
  error?: string;
}

/**
 * Routes a `meeting_token` frame to the request waiting for it. Unknown or
 * expired pane ids are ignored. Called from useWebSocket.
 */
export function resolveMeetingToken(data: MeetingTokenReply | undefined): void {
  const key = data?.pane_id || (data?.room ? roomKey(data.room) : '');
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  clearTimeout(p.entry.timer);
  if (data?.error) {
    p.entry.reject(new Error(data.error));
    return;
  }
  try {
    p.entry.resolve(checkGrant({ url: data?.url, token: data?.token, identity: data?.identity }));
  } catch (e) {
    p.entry.reject(e as Error);
  }
}

/** Asks the daemon for a join grant for this meeting pane's room. */
export function requestMeetingToken(paneId: string, room?: string): Promise<JoinGrant> {
  return request(paneId, { pane_id: paneId }, room);
}

/** Asks the daemon for a join grant for a room on the session's rysh server. */
export function requestRoomToken(room: string): Promise<JoinGrant> {
  if (!validRoom(room)) return Promise.reject(new Error('Room ids use letters, digits, - and _ (max 64).'));
  return request(roomKey(room), { room }, room);
}

/** The header Meeting panel's token source: the daemon, by room id. */
export const daemonTokenSource: TokenSource = requestRoomToken;

function roomKey(room: string): string {
  return `room:${room}`;
}

function request(key: string, params: Record<string, string>, room?: string): Promise<JoinGrant> {
  const inflight = pending.get(key);
  if (inflight) return inflight.promise;
  const ws = useStore.getState().ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Not connected to the rysh daemon.'));
  }
  let entry!: Pending;
  const promise = new Promise<JoinGrant>((resolve, reject) => {
    entry = {
      resolve: (g) => resolve(room ? { ...g, room } : g),
      reject,
      timer: setTimeout(() => {
        pending.delete(key);
        reject(new Error('The rysh daemon did not answer with a join token.'));
      }, TIMEOUT_MS),
    };
  });
  pending.set(key, { promise, entry });
  sendCommand(MEETING_TOKEN_ACTION, params);
  return promise;
}
