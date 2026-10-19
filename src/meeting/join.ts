// How the meeting panel gets into a rysh LiveKit room (design 042, LK-4).
//
// A room is entered with a LiveKit server URL and a signed join token. The
// token names the participant's identity, which is what the bot trusts (never
// a display name), so the app never mints one itself. Two sources:
//
//  - a join link or pasted URL + token: what `rysh meeting host` prints and
//    what `lk token create` gives against a local `livekit-server --dev`;
//  - a room id: the daemon asks rysh-server's token endpoint (LK-3,
//    POST /api/meeting-rooms/<room id>/token) with its own rysh key and hands
//    back the grant (daemonToken.ts, E-87). The app holds no rysh account
//    credential and never calls rysh-server for a token itself.

export interface JoinGrant {
  /** LiveKit signalling URL, ws:// or wss://. */
  url: string;
  token: string;
  identity?: string;
  room?: string;
}

/** Asks for a grant to one room. Implementations throw a readable Error. */
export type TokenSource = (room: string) => Promise<JoinGrant>;

// Room ids (rysh-server record ids) and LiveKit room names share this shape.
const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function validRoom(room: string): boolean {
  return ROOM_RE.test(room);
}

function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Validates a grant: a wss:// URL (ws:// only for a local dev server) and a
 * JWT-shaped token. Throws on anything else.
 */
export function checkGrant(g: Partial<JoinGrant>): JoinGrant {
  if (typeof g.url !== 'string' || typeof g.token !== 'string') {
    throw new Error('The join details need a server URL and a token.');
  }
  let u: URL;
  try {
    u = new URL(g.url);
  } catch {
    throw new Error('The server URL is not a valid URL.');
  }
  if (u.username || u.password) throw new Error('The server URL must not carry credentials.');
  if (!(u.protocol === 'wss:' || (u.protocol === 'ws:' && isLocal(u.hostname)))) {
    throw new Error('The server URL must use wss:// (ws:// only for a local dev server).');
  }
  const token = g.token.trim();
  if (!JWT_RE.test(token)) throw new Error('The token is not a LiveKit join token.');
  const grant: JoinGrant = { url: u.toString().replace(/\/$/, ''), token };
  if (typeof g.identity === 'string' && g.identity) grant.identity = g.identity;
  if (typeof g.room === 'string' && g.room) grant.room = g.room;
  return grant;
}

/**
 * Reads a join link. Accepted forms: any URL whose query or fragment carries
 * url= (or liveKitUrl=, the LiveKit Meet form) and token=; or a JSON grant.
 */
export function parseJoinLink(input: string): JoinGrant {
  const s = input.trim();
  if (s.startsWith('{')) {
    try {
      return checkGrant(JSON.parse(s));
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error('The join details are not valid JSON.');
      throw e;
    }
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Paste a join link, or enter the server URL and token.');
  }
  const params = new URLSearchParams(u.search);
  new URLSearchParams(u.hash.replace(/^#/, '')).forEach((v, k) => params.set(k, v));
  return checkGrant({
    url: params.get('url') ?? params.get('liveKitUrl') ?? undefined,
    token: params.get('token') ?? undefined,
    room: params.get('room') ?? undefined,
  });
}
