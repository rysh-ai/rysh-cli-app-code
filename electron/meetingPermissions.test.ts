import { describe, expect, it, vi } from 'vitest'
import {
  installMeetingPermissions,
  isMeetingOrigin,
  meetingPermission,
  type MeetingPermissionQuery,
  type MeetingPermissionVerdict,
  type PermissionSession,
} from './meetingPermissions'
import { webPanePermission } from './webPanePermissions'

// Design 043, Decision 8: camera/mic/screen share only for a meeting pane's own
// webContents on an allowlisted platform origin; everything this policy leaves
// "default" goes to the web-pane policy (webPanePermissions.ts, E-76: deny).

const table: Array<[string, MeetingPermissionQuery, MeetingPermissionVerdict]> = [
  // meeting pane, allowlisted origin
  ['meet: mic+camera', { isMeetingPane: true, origin: 'https://meet.google.com', permission: 'media', mediaTypes: ['audio', 'video'] }, 'allow'],
  ['meet: mic only (full URL)', { isMeetingPane: true, origin: 'https://meet.google.com/abc-defg-hij', permission: 'media', mediaTypes: ['audio'] }, 'allow'],
  ['meet: screen share', { isMeetingPane: true, origin: 'https://meet.google.com', permission: 'display-capture' }, 'allow'],
  ['zoom subdomain', { isMeetingPane: true, origin: 'https://us05web.zoom.us', permission: 'media', mediaTypes: ['video'] }, 'allow'],
  ['zoom apex', { isMeetingPane: true, origin: 'https://zoom.us', permission: 'media', mediaTypes: ['audio'] }, 'allow'],
  ['zoom.com subdomain', { isMeetingPane: true, origin: 'https://app.zoom.com', permission: 'display-capture' }, 'allow'],
  ['teams work', { isMeetingPane: true, origin: 'https://teams.microsoft.com', permission: 'media', mediaTypes: ['audio', 'video'] }, 'allow'],
  ['teams live', { isMeetingPane: true, origin: 'https://teams.live.com', permission: 'media', mediaTypes: ['audio'] }, 'allow'],
  ['check handler: unknown media type', { isMeetingPane: true, origin: 'https://meet.google.com', permission: 'media', mediaTypes: ['unknown'] }, 'allow'],
  ['media with no types', { isMeetingPane: true, origin: 'https://meet.google.com', permission: 'media' }, 'allow'],
  // meeting pane, other origin or bad shape → deny
  ['meeting pane on another site', { isMeetingPane: true, origin: 'https://example.com', permission: 'media', mediaTypes: ['audio'] }, 'deny'],
  ['lookalike host', { isMeetingPane: true, origin: 'https://meet.google.com.evil.io', permission: 'media', mediaTypes: ['audio'] }, 'deny'],
  ['suffix without a dot', { isMeetingPane: true, origin: 'https://evilzoom.us', permission: 'display-capture' }, 'deny'],
  ['plain http', { isMeetingPane: true, origin: 'http://meet.google.com', permission: 'media', mediaTypes: ['audio'] }, 'deny'],
  ['credentials in URL', { isMeetingPane: true, origin: 'https://u:p@meet.google.com', permission: 'media', mediaTypes: ['audio'] }, 'deny'],
  ['empty origin', { isMeetingPane: true, origin: '', permission: 'display-capture' }, 'deny'],
  ['teams, unknown media type mix', { isMeetingPane: true, origin: 'https://teams.microsoft.com', permission: 'media', mediaTypes: ['audio', 'midi'] }, 'deny'],
  // meeting pane, a permission this policy does not decide → today's behaviour
  ['meeting pane notifications', { isMeetingPane: true, origin: 'https://meet.google.com', permission: 'notifications' }, 'default'],
  ['meeting pane fullscreen elsewhere', { isMeetingPane: true, origin: 'https://example.com', permission: 'fullscreen' }, 'default'],
  // not a meeting pane → today's behaviour, whatever the origin
  ['web pane on meet', { isMeetingPane: false, origin: 'https://meet.google.com', permission: 'media', mediaTypes: ['audio', 'video'] }, 'default'],
  ['web pane anywhere', { isMeetingPane: false, origin: 'https://example.com', permission: 'display-capture' }, 'default'],
]

describe('meetingPermission', () => {
  it.each(table)('%s', (_name, q, want) => {
    expect(meetingPermission(q)).toBe(want)
  })

  it('rejects unparsable origins', () => {
    expect(isMeetingOrigin('meet.google.com')).toBe(false)
    expect(isMeetingOrigin('not a url')).toBe(false)
  })
})

// Captures the three handlers installMeetingPermissions registers.
function fakeSession() {
  const h: {
    request?: Parameters<PermissionSession['setPermissionRequestHandler']>[0]
    check?: Parameters<PermissionSession['setPermissionCheckHandler']>[0]
    display?: Parameters<PermissionSession['setDisplayMediaRequestHandler']>[0]
    displayOpts?: unknown
    device?: Parameters<PermissionSession['setDevicePermissionHandler']>[0]
  } = {}
  const ses: PermissionSession = {
    setPermissionRequestHandler: (fn) => {
      h.request = fn
    },
    setPermissionCheckHandler: (fn) => {
      h.check = fn
    },
    setDisplayMediaRequestHandler: (fn, opts) => {
      h.display = fn
      h.displayOpts = opts
    },
    setDevicePermissionHandler: (fn) => {
      h.device = fn
    },
  }
  return { ses, h }
}

describe('installMeetingPermissions', () => {
  // Two webContents on ONE partition: the decision follows the requester.
  const meetingWC = { id: 1 } as unknown as Electron.WebContents
  const webWC = { id: 2 } as unknown as Electron.WebContents
  const frameOf = new Map<unknown, Electron.WebContents>()
  const meetingFrame = { url: 'https://meet.google.com/x' } as unknown as Electron.WebFrameMain
  const webFrame = { url: 'https://meet.google.com/x' } as unknown as Electron.WebFrameMain
  frameOf.set(meetingFrame, meetingWC)
  frameOf.set(webFrame, webWC)
  const source = { id: 'screen:1:0', name: 'Screen 1' } as Electron.DesktopCapturerSource

  function install(pick: () => Promise<Electron.DesktopCapturerSource | null> = vi.fn(async () => source)) {
    const { ses, h } = fakeSession()
    installMeetingPermissions(ses, {
      isMeetingPane: (wc) => wc === meetingWC,
      contentsOfFrame: (f) => frameOf.get(f),
      pickSource: pick,
      whenUndecided: webPanePermission,
    })
    return { h, pick }
  }

  it('decides per requesting webContents, not per partition', () => {
    const { h } = install()
    const cb = vi.fn()
    const details = { requestingUrl: 'https://meet.google.com/abc', mediaTypes: ['audio', 'video'] }
    h.request!(meetingWC, 'media', cb, details as never)
    h.request!(webWC, 'media', cb, details as never)
    h.request!(meetingWC, 'media', cb, { requestingUrl: 'https://example.com', mediaTypes: ['audio'] } as never)
    h.request!(webWC, 'geolocation', cb, { requestingUrl: 'https://example.com' } as never)
    h.request!(webWC, 'fullscreen', cb, { requestingUrl: 'https://example.com' } as never)
    // web pane on meet.google.com: not a meeting pane → web-pane policy → no mic (E-76)
    expect(cb.mock.calls.map((c) => c[0])).toEqual([true, false, false, false, true])
  })

  it('check handler reads the requesting origin and media type', () => {
    const { h } = install()
    expect(h.check!(meetingWC, 'media', 'https://teams.microsoft.com', { mediaType: 'video' } as never)).toBe(true)
    expect(h.check!(meetingWC, 'media', 'https://example.com', { mediaType: 'audio' } as never)).toBe(false)
    expect(h.check!(webWC, 'media', 'https://example.com', { mediaType: 'audio' } as never)).toBe(false)
    expect(h.check!(null, 'media', 'https://example.com', {} as never)).toBe(false)
    expect(h.check!(webWC, 'clipboard-sanitized-write', 'https://example.com', {} as never)).toBe(true)
  })

  it('screen share: picker only for a meeting pane on an allowlisted origin, never the system picker', async () => {
    const { h, pick } = install()
    expect(h.displayOpts).toBeUndefined()
    const allowed = await new Promise((resolve) =>
      h.display!({ frame: meetingFrame, securityOrigin: 'https://meet.google.com' } as never, resolve),
    )
    expect(allowed).toEqual({ video: source })
    expect(pick).toHaveBeenCalledTimes(1)
    const webPane = await new Promise((resolve) =>
      h.display!({ frame: webFrame, securityOrigin: 'https://meet.google.com' } as never, resolve),
    )
    expect(webPane).toEqual({})
    const offList = await new Promise((resolve) =>
      h.display!({ frame: meetingFrame, securityOrigin: 'https://example.com' } as never, resolve),
    )
    expect(offList).toEqual({})
    expect(pick).toHaveBeenCalledTimes(1)
  })

  it('screen share: a cancelled or failed picker shares nothing', async () => {
    const { h } = install(vi.fn(async () => null))
    expect(
      await new Promise((r) => h.display!({ frame: meetingFrame, securityOrigin: 'https://zoom.us' } as never, r)),
    ).toEqual({})
    const failing = install(vi.fn(async () => Promise.reject(new Error('no sources'))))
    expect(
      await new Promise((r) =>
        failing.h.display!({ frame: meetingFrame, securityOrigin: 'https://zoom.us' } as never, r),
      ),
    ).toEqual({})
  })
})
