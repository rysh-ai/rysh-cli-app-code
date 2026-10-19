import { sendCommand } from '../utils/commands';

// The meeting pane contract, daemon → app (design 043 §"Pane contract").
//
// A `##meeting join` pane is shell-less, `pane_type "meeting"`, and is BORN
// with its meta so it never renders half-configured:
//   meeting.id, meeting.kind (web|livekit), meeting.platform, meeting.url,
//   meeting.profile (web), meeting.room + meeting.server (livekit)
// and later gets, via MsgPaneSetMeta:
//   meeting.agents (comma list), meeting.bot ("" | joining | in_call | left | failed),
//   meeting.bots ("<agent>:<phase>,…" — one bot per agent, design 043 D9),
//   meeting.reporter ("" | joining | in_call | left | failed — the silent
//   reporter bot, design 045) and meeting.report (absolute path of the
//   reporter's newest report.md, design 045)

export const MEETING_PANE_TYPE = 'meeting';
/** The web-mode default profile, so a Google login made in web mode carries over. */
export const DEFAULT_MEETING_PROFILE = 'default';

export type MeetingKind = 'web' | 'livekit';

export interface MeetingPaneInfo {
  id: string;
  /** '' when the meta names no kind this app knows. */
  kind: MeetingKind | '';
  platform: string;
  url: string;
  profile: string;
  room: string;
  server: string;
  agents: string[];
  bot: string;
  /** Each agent bot's phase (design 043 D9); empty from an older daemon. */
  bots: { agent: string; phase: string }[];
  /** The silent reporter's phase (design 045); '' when there is none. */
  reporter: string;
  /** The reporter's newest report.md (interim or final); '' until one is written. */
  report: string;
}

/** Reads the meeting.* keys of a meeting pane's meta. */
export function meetingInfo(meta: Record<string, string> | undefined): MeetingPaneInfo {
  const m = meta || {};
  const get = (k: string) => (m[`meeting.${k}`] ?? '').trim();
  const kind = get('kind').toLowerCase();
  return {
    id: get('id'),
    kind: kind === 'web' || kind === 'livekit' ? kind : '',
    platform: get('platform'),
    url: get('url'),
    profile: get('profile') || DEFAULT_MEETING_PROFILE,
    room: get('room'),
    server: get('server'),
    agents: get('agents')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    bot: get('bot'),
    bots: get('bots')
      .split(',')
      .map((pair) => {
        const at = pair.lastIndexOf(':');
        return { agent: pair.slice(0, at).trim(), phase: pair.slice(at + 1).trim() };
      })
      .filter((b) => b.agent),
    reporter: get('reporter'),
    report: get('report'),
  };
}

/**
 * Meeting pages the embedded browser may open: https only, no credentials in
 * the URL. The daemon already validates the platform (040 MTG-10); this guards
 * the renderer against a meta value it did not expect.
 */
export function safeMeetingUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    return u.toString();
  } catch {
    return '';
  }
}

/** Meeting ids are `m-` + 6 lowercase hex (design 043 §Command grammar). */
export function validMeetingId(id: string): boolean {
  return /^m-[0-9a-f]{6}$/.test(id);
}

/** True when this app can open a local meeting report (the desktop app, not the browser UI). */
export function canOpenMeetingReport(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.openMeetingReport === 'function';
}

/**
 * Opens the meeting's report.md in the OS's default app. The main process
 * accepts only `<…>/meetings/<meetingId>/report.md` (electron/meetingReport.ts).
 */
export function openMeetingReport(meetingId: string, path: string): void {
  if (!validMeetingId(meetingId) || !path || !canOpenMeetingReport()) return;
  void window.electronAPI!.openMeetingReport(meetingId, path).then((r) => {
    if (!r.success) console.warn(`[meeting] cannot open the report of ${meetingId}: ${r.error}`);
  });
}

/**
 * Leaves the meeting: the daemon makes the bot leave, closes this pane and
 * drops the registry entry. Routed as a `##` line through submit_input, the
 * same way resumeWebSync drives `##pane sync on` (utils/paneSync.ts).
 */
export function leaveMeeting(paneId: string, meetingId: string): void {
  // The id becomes part of a `##` command line; anything but a well-formed id
  // could smuggle extra arguments into it.
  if (!validMeetingId(meetingId)) return;
  sendCommand('submit_input', { text: `##meeting leave ${meetingId}`, mode: 'rysh', pane_id: paneId });
}
