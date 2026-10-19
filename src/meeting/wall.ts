// The rysh bot's progress wall, as seen from the app's meeting panel.
//
// In a Recall meeting the wall is a web page on the bot's camera tile
// (rysh-cli internal/meeting/media.html, design 040 MTG-13). In a rysh-native
// LiveKit room (design 042) the bot sends the same status message on a
// reliable data channel instead, and this panel renders it as UI:
//
//   topic "rysh.wall", payload = UTF-8 JSON
//   {"type":"status","phase":"thinking","state":"executing","speaker":"Ada",
//    "request":"what changed today","agent":"docs","activity":"…",
//    "caption":"…","elapsed_ms":1234}
//
// Only "type" and "phase" are required; every other field is optional, and
// unknown phases render as "Working" so a newer bot never breaks an older app.

export const WALL_TOPIC = 'rysh.wall';

export type WallPhase =
  | 'joining'
  | 'listening'
  | 'heard'
  | 'awaiting_approval'
  | 'thinking'
  | 'preparing_speech'
  | 'speaking'
  | 'error'
  | 'paused'
  | 'ended'
  | 'working';

export interface WallStatus {
  phase: WallPhase;
  speaker?: string;
  request?: string;
  agent?: string;
  activity?: string;
  caption?: string;
  error?: string;
  /** Turn age when the bot sent the message. */
  elapsedMs?: number;
}

/** Label and hint per phase — the same words as the meeting tile page. */
export const WALL_LABELS: Record<WallPhase, [string, string]> = {
  joining: ['Joining the meeting', ''],
  listening: ['Listening', 'Say “hey rysh” and ask a question'],
  heard: ['Hearing your request', ''],
  awaiting_approval: ['Waiting for approval', 'The operator reviews each request'],
  thinking: ['Thinking', 'Working on your request'],
  preparing_speech: ['Preparing the answer', 'Turning the reply into speech'],
  speaking: ['Speaking', ''],
  error: ['Couldn’t complete that', 'Please ask again'],
  paused: ['Paused', 'The assistant is not listening'],
  ended: ['Left the meeting', ''],
  working: ['Working', ''],
};

/** Phases during which a turn is in flight (who / what / timer are shown). */
export const TURN_PHASES: ReadonlySet<WallPhase> = new Set<WallPhase>([
  'heard', 'awaiting_approval', 'thinking', 'preparing_speech', 'speaking', 'error',
]);

const MAX_PAYLOAD = 16 * 1024;

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!clean) return undefined;
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : clean;
}

/**
 * Decodes one data-channel payload. Returns null for anything that is not a
 * well-formed status message, so a bad packet is ignored rather than shown.
 */
export function parseWall(payload: Uint8Array | string): WallStatus | null {
  const raw = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
  if (raw.length > MAX_PAYLOAD) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.type !== 'status' || typeof o.phase !== 'string') return null;
  const phase = (o.phase in WALL_LABELS ? o.phase : 'working') as WallPhase;
  const status: WallStatus = { phase };
  const speaker = text(o.speaker, 80);
  const request = text(o.request, 160);
  const agent = text(o.agent, 40);
  const activity = text(o.activity, 80);
  const caption = phase === 'speaking' ? text(o.caption, 6000) : undefined;
  const error = phase === 'error' ? text(o.error, 160) : undefined;
  if (speaker) status.speaker = speaker;
  if (request) status.request = request;
  if (agent) status.agent = agent;
  if (activity) status.activity = activity;
  if (caption) status.caption = caption;
  if (error) status.error = error;
  if (typeof o.elapsed_ms === 'number' && Number.isFinite(o.elapsed_ms) && o.elapsed_ms >= 0) {
    status.elapsedMs = o.elapsed_ms;
  }
  return status;
}

/** The secondary line under the phase label. */
export function wallDetail(s: WallStatus): string {
  const [, hint] = WALL_LABELS[s.phase];
  const agent = s.agent ? s.agent.charAt(0).toUpperCase() + s.agent.slice(1) : '';
  if (s.activity) return s.activity;
  if (s.phase === 'error' && s.error) return s.error;
  if (agent && s.phase === 'thinking') return `${agent} is working on it`;
  if (agent && s.phase === 'speaking') return `${agent} is answering`;
  // An agent bot (design 043 D9) is woken by its own name, not "hey rysh".
  if (s.agent && s.phase === 'listening') return `Say “hey ${s.agent}” and ask a question`;
  return hint;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
