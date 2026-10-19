import { useStore } from '../store';
import { sendCommand } from '../utils/commands';

// Meeting-bot lifecycle controls (E17 k2, MTG-6, design 040): the app's half.
// The daemon's web server forwards `meeting_command` as the same
// MsgMeetingCommand the CLI and TUI send (rysh-cli internal/web/meeting.go):
//
//   → {type:"command", data:{action:"meeting_command", params:{id, verb, turn_id?}}}
//   ← {type:"meeting_reply", data:{id, verb, reply, error}}
//
// Every command names its meeting by registry id — there is no "only meeting"
// default here — and a reply is matched by the id AND verb it echoes, so with
// two meetings open a reply for one can never answer the other. list, status
// and leave stay with ##meeting and the pane header (E30 PM-4).

export const MEETING_COMMAND_ACTION = 'meeting_command';
const TIMEOUT_MS = 30000;
const MEETING_ID = /^m-[0-9a-f]{6}$/; // rysh-cli internal/meeting/registry.go

export type MeetingVerb = 'pending' | 'approve' | 'reject' | 'speak' | 'pause' | 'resume' | 'cancel';
const VERBS: ReadonlySet<string> = new Set(['pending', 'approve', 'reject', 'speak', 'pause', 'resume', 'cancel']);

/** The daemon's meeting.Reply, as far as the panel reads it. */
export interface MeetingBotReply {
  id?: string;
  state?: string;
  phase?: string;
  mode?: string;
  turn_id?: string;
  speaker?: string;
  agent?: string;
  request?: string;
  result?: string;
  notice?: string;
  error?: string;
}

export interface MeetingReplyFrame {
  id?: string;
  verb?: string;
  reply?: MeetingBotReply;
  error?: string;
}

interface Pending {
  resolve: (r: MeetingBotReply) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// One request in flight per meeting and verb; a repeat shares the answer.
const pending = new Map<string, { promise: Promise<MeetingBotReply>; entry: Pending }>();
const keyOf = (id: string, verb: string) => `${id}\u0000${verb}`;

export function validMeetingId(id: string | undefined): id is string {
  return !!id && MEETING_ID.test(id);
}

/** Sends one lifecycle verb for one meeting and resolves with the daemon's reply. */
export function sendMeetingCommand(id: string, verb: MeetingVerb, turnId?: string): Promise<MeetingBotReply> {
  if (!validMeetingId(id)) return Promise.reject(new Error('A meeting command needs the meeting id (m-xxxxxx).'));
  if (!VERBS.has(verb)) return Promise.reject(new Error(`${verb} is not a meeting panel control.`));
  const key = keyOf(id, verb);
  const inflight = pending.get(key);
  if (inflight) return inflight.promise;
  const ws = useStore.getState().ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to the rysh daemon.'));
  let entry!: Pending;
  const promise = new Promise<MeetingBotReply>((resolve, reject) => {
    entry = {
      resolve,
      reject,
      timer: setTimeout(() => {
        pending.delete(key);
        reject(new Error('The rysh daemon did not answer the meeting command.'));
      }, TIMEOUT_MS),
    };
  });
  pending.set(key, { promise, entry });
  const params: Record<string, string> = { id, verb };
  if (turnId) params.turn_id = turnId;
  sendCommand(MEETING_COMMAND_ACTION, params);
  return promise;
}

/** Routes a `meeting_reply` frame to the request waiting for it. Called from useWebSocket. */
export function resolveMeetingReply(data: MeetingReplyFrame | undefined): void {
  if (!data?.id || !data.verb) return;
  const key = keyOf(data.id, data.verb);
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  clearTimeout(p.entry.timer);
  if (data.error) p.entry.reject(new Error(data.error));
  else p.entry.resolve(data.reply || {});
}

/** The verbs the bot's state allows, in display order (refresh is always there). */
export function panelVerbs(r: MeetingBotReply | undefined): MeetingVerb[] {
  if (!r) return [];
  const out: MeetingVerb[] = [];
  if (r.state === 'awaiting_approval' && r.turn_id) out.push('approve', 'reject');
  if (r.state === 'awaiting_speech' && r.turn_id) out.push('speak', 'reject');
  out.push(r.state === 'paused' ? 'resume' : 'pause', 'cancel');
  return out;
}
