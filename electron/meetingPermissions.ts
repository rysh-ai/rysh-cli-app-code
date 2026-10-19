// Camera / microphone / screen-share policy for meeting panes (design 043,
// Decision 8).
//
// A meeting pane is a web pane (same WebContentsView, same `persist:<profile>`
// partition, so a Google login made in web mode carries over) that additionally
// needs the camera, the microphone and screen share. Those are granted ONLY
// when the request comes from a meeting pane's own webContents AND its origin
// is a meeting platform on the allowlist below.
//
// The decision is made per requesting webContents, never per partition: one
// profile partition can hold a plain web pane and a meeting pane at once, and
// Electron keeps one set of handlers per session (a second
// setPermissionRequestHandler replaces the first). So webPaneManager installs
// these handlers once on EVERY web-pane partition, meeting or not, and what
// this policy leaves undecided ("default": every non-meeting webContents, and
// the permissions D8 does not decide) goes to the caller's `whenUndecided` —
// the web-pane policy in webPanePermissions.ts (E-76), which denies by default.
// Nothing reaches Electron's own grant-everything default.
//
// The LiveKit (rysh room) renderer is the app's own main window on the default
// session; main.ts already grants `media` to that window only.

/**
 * Hosts whose pages may use camera, microphone and screen share in a meeting pane.
 * teams.cloud.microsoft is Microsoft's newer host for the Teams web client
 * (serves 200, 2026-09-29); a browser join can move there from teams.microsoft.com.
 */
const EXACT_HOSTS = new Set(['meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'])
const SUFFIX_HOSTS = ['zoom.us', 'zoom.com']

/** The sensitive permissions this policy decides; everything else is "default". */
const MEETING_PERMISSIONS = new Set(['media', 'display-capture'])
const MEDIA_TYPES = new Set(['audio', 'video'])

export type MeetingPermissionVerdict = 'allow' | 'deny' | 'default'

export interface MeetingPermissionQuery {
  /** The requesting webContents is a meeting pane's view. */
  isMeetingPane: boolean
  /** Requesting origin or URL (frame-level: the frame that asked). */
  origin: string
  /** Electron permission name ("media", "display-capture", "notifications", …). */
  permission: string
  /** For "media": what was asked for ("audio", "video"; "unknown" from check handlers). */
  mediaTypes?: readonly string[]
}

/** True when `origin` (an origin or full URL) is https on a meeting-platform host. */
export function isMeetingOrigin(origin: string): boolean {
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  if (EXACT_HOSTS.has(host)) return true
  return SUFFIX_HOSTS.some((s) => host === s || host.endsWith(`.${s}`))
}

/**
 * The policy as a pure function.
 *
 *  - not a meeting pane               → "default": the caller's web-pane policy decides
 *  - meeting pane, openExternal       → "deny" (zoommtg:/msteams: app hand-off; stay in the browser)
 *  - meeting pane, other permission   → "default" (fullscreen, notifications, clipboard… as for web panes)
 *  - meeting pane, media/display-capture, allowlisted https origin → "allow"
 *    (media only for audio/video; an unknown media type from a check is allowed,
 *    the later request carries the real types)
 *  - meeting pane, media/display-capture, anything else → "deny"
 */
export function meetingPermission(q: MeetingPermissionQuery): MeetingPermissionVerdict {
  if (!q.isMeetingPane) return 'default'
  // A meeting pane never hands a link to another app: Zoom's and Teams'
  // landing pages open zoommtg:/msteams: links, which Electron gives to the
  // OS (launching the desktop client) whenever `openExternal` is granted.
  // Denied, the page offers its in-browser join instead.
  if (q.permission === 'openExternal') return 'deny'
  if (!MEETING_PERMISSIONS.has(q.permission)) return 'default'
  if (!isMeetingOrigin(q.origin)) return 'deny'
  if (q.permission === 'media') {
    const types = (q.mediaTypes ?? []).filter((t) => t !== 'unknown')
    if (!types.every((t) => MEDIA_TYPES.has(t))) return 'deny'
  }
  return 'allow'
}

/** The slice of Electron's Session this module installs handlers on. */
export interface PermissionSession {
  setPermissionRequestHandler: Electron.Session['setPermissionRequestHandler']
  setPermissionCheckHandler: Electron.Session['setPermissionCheckHandler']
  setDisplayMediaRequestHandler: Electron.Session['setDisplayMediaRequestHandler']
  setDevicePermissionHandler: Electron.Session['setDevicePermissionHandler']
}

export interface MeetingPermissionDeps {
  isMeetingPane: (wc: Electron.WebContents | null | undefined) => boolean
  /** Resolves the webContents behind a display-media request's frame. */
  contentsOfFrame: (frame: Electron.WebFrameMain | null) => Electron.WebContents | null | undefined
  /** The screen/window picker for an allowed share; null = cancelled. */
  pickSource: () => Promise<Electron.DesktopCapturerSource | null>
  /** The answer for a request this policy leaves "default" (webPanePermission). */
  whenUndecided: (permission: string) => boolean
}

/**
 * Installs the permission handlers on one web-pane partition (every partition a
 * web or meeting pane uses). Idempotence is the caller's (webPaneManager keeps a
 * WeakSet of patched sessions).
 */
export function installMeetingPermissions(ses: PermissionSession, deps: MeetingPermissionDeps): void {
  const granted = (v: MeetingPermissionVerdict, permission: string): boolean =>
    v === 'default' ? deps.whenUndecided(permission) : v === 'allow'
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const d = details as { requestingUrl?: string; mediaTypes?: string[] }
    callback(
      granted(
        meetingPermission({
          isMeetingPane: deps.isMeetingPane(wc),
          origin: d?.requestingUrl ?? '',
          permission,
          mediaTypes: d?.mediaTypes,
        }),
        permission,
      ),
    )
  })
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
    granted(
      meetingPermission({
        isMeetingPane: deps.isMeetingPane(wc),
        origin: requestingOrigin || details?.requestingUrl || '',
        permission,
        mediaTypes: details?.mediaType ? [details.mediaType] : undefined,
      }),
      permission,
    ),
  )
  // WebHID / WebSerial / WebUSB device access: no pane needs it, none may have it.
  ses.setDevicePermissionHandler(() => false)
  // getDisplayMedia has no default in Electron (it fails without a handler), so
  // "default" here means "no screen share", exactly as before for web panes.
  //
  // No `useSystemPicker`: on macOS 15+ it makes Electron skip this handler
  // entirely, and then a plain web pane sharing the partition could start a
  // screen share it cannot start today. The per-webContents check wins; the
  // app's own picker (pickSource) is used on every platform.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const verdict = meetingPermission({
      isMeetingPane: deps.isMeetingPane(deps.contentsOfFrame(request.frame)),
      origin: request.securityOrigin || request.frame?.url || '',
      permission: 'display-capture',
    })
    if (verdict !== 'allow') {
      callback({})
      return
    }
    deps.pickSource().then(
      (source) => callback(source ? { video: source } : {}),
      () => callback({}),
    )
  })
}
