import { describe, expect, it } from 'vitest'
import { meetingBrowserUrl, meetingNavigationTarget } from './meetingJoinUrl'
import { isMeetingOrigin, meetingPermission, type MeetingPermissionVerdict } from './meetingPermissions'

// Design 043 §"Zoom and Teams in panes": a Zoom or Teams link opens the
// platform's browser join in a meeting pane, and that pane gets camera, mic
// and screen share on every Zoom/Teams origin a join can run on — and never
// hands a link to the desktop app.

const TEAMS_JOIN =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjQ1MjBkYzItYjU0Yi00ZDIxLWE4ZGEtOTc0YzQ5ZjQ2ZmZh%40thread.v2/0?context=%7b%22Tid%22%3a%2272f988bf-86f1-41af-91ab-2d7cd011db47%22%2c%22Oid%22%3a%22a1b2c3d4-0000-4000-8000-000000000000%22%7d'

describe('meetingBrowserUrl — Zoom', () => {
  it.each([
    ['zoom.us /j with passcode', 'https://zoom.us/j/81234567890?pwd=AbCdEf123.1', 'https://app.zoom.us/wc/81234567890/join?fromPWA=1&pwd=AbCdEf123.1'],
    ['regional subdomain', 'https://us06web.zoom.us/j/81234567890?pwd=AbCdEf123.1', 'https://app.zoom.us/wc/81234567890/join?fromPWA=1&pwd=AbCdEf123.1'],
    ['vanity subdomain, omn dropped', 'https://acme.zoom.us/j/81234567890?pwd=x&omn=81234567890', 'https://app.zoom.us/wc/81234567890/join?fromPWA=1&pwd=x'],
    ['zoom.com, no passcode', 'https://zoom.com/j/81234567890', 'https://app.zoom.us/wc/81234567890/join?fromPWA=1'],
    ['old web client /wc/join/<id>', 'https://zoom.us/wc/join/81234567890?pwd=x', 'https://app.zoom.us/wc/81234567890/join?fromPWA=1&pwd=x'],
    ['web client on another host', 'https://zoom.us/wc/81234567890/join?pwd=x', 'https://app.zoom.us/wc/81234567890/join?fromPWA=1&pwd=x'],
    ['9-digit id', 'https://zoom.us/j/812345678', 'https://app.zoom.us/wc/812345678/join?fromPWA=1'],
  ])('%s', (_name, input, want) => {
    expect(meetingBrowserUrl(input)).toBe(want)
  })

  it.each([
    ['the web client itself', 'https://app.zoom.us/wc/81234567890/join?fromPWA=1&pwd=x'],
    ['a page inside the web client', 'https://app.zoom.us/wc/81234567890/start?fromPWA=1'],
    ['web client without fromPWA', 'https://app.zoom.us/wc/81234567890/join?pwd=x'],
    ['personal link (no meeting id)', 'https://acme.zoom.us/my/jane.doe'],
    ['webinar', 'https://zoom.us/w/81234567890'],
    ['host start link', 'https://zoom.us/s/81234567890'],
    ['lookalike host', 'https://zoom.us.evil.example/j/81234567890'],
    ['nested subdomain', 'https://a.b.zoom.us/j/81234567890'],
    ['http', 'http://zoom.us/j/81234567890'],
    ['explicit port', 'https://zoom.us:8443/j/81234567890'],
  ])('leaves %s unchanged', (_name, input) => {
    expect(meetingBrowserUrl(input)).toBe(input)
  })

  it('keeps nothing but the passcode (no zak/tk credential is carried over)', () => {
    const out = new URL(meetingBrowserUrl('https://zoom.us/j/81234567890?pwd=x&zak=secret&tk=reg'))
    expect([...out.searchParams.keys()].sort()).toEqual(['fromPWA', 'pwd'])
  })
})

/** The deep link a Teams launcher URL carries, decoded. */
function deepLink(launcher: string): { host: string; params: URLSearchParams; url: string } {
  const u = new URL(launcher)
  return { host: u.hostname, params: u.searchParams, url: u.searchParams.get('url') ?? '' }
}

describe('meetingBrowserUrl — Teams', () => {
  it('meetup-join → launcher, in the browser, as a guest', () => {
    const { host, params, url } = deepLink(meetingBrowserUrl(TEAMS_JOIN))
    expect(host).toBe('teams.microsoft.com')
    expect(new URL(meetingBrowserUrl(TEAMS_JOIN)).pathname).toBe('/dl/launcher/launcher.html')
    expect(params.get('msLaunch')).toBe('false')
    expect(params.get('suppressPrompt')).toBe('true')
    expect(params.get('type')).toBe('meetup-join')
    expect(params.get('directDl')).toBe('true')
    // The same deep link Teams' own redirect builds: decoded thread, context kept, anon=true.
    expect(url.startsWith('/_#/l/meetup-join/19:meeting_NjQ1MjBkYzItYjU0Yi00ZDIxLWE4ZGEtOTc0YzQ5ZjQ2ZmZh@thread.v2/0?')).toBe(true)
    const inner = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(JSON.parse(inner.get('context') ?? '')).toEqual({ Tid: '72f988bf-86f1-41af-91ab-2d7cd011db47', Oid: 'a1b2c3d4-0000-4000-8000-000000000000' })
    expect(inner.get('anon')).toBe('true')
  })

  it('does not add a second anon', () => {
    const { url } = deepLink(meetingBrowserUrl(`${TEAMS_JOIN}&anon=true`))
    expect(url.match(/anon=/g)).toHaveLength(1)
  })

  it.each([
    ['business short link', 'https://teams.microsoft.com/meet/2345678901234?p=AbCdEfGh', 'teams.microsoft.com'],
    ['personal short link', 'https://teams.live.com/meet/9876543210987?p=XyZ123', 'teams.live.com'],
  ])('%s → launcher on the same host', (_name, input, wantHost) => {
    const { host, params, url } = deepLink(meetingBrowserUrl(input))
    expect(host).toBe(wantHost)
    expect(params.get('type')).toBe('meet')
    expect(params.get('msLaunch')).toBe('false')
    expect(url).toBe(`/_#${new URL(input).pathname}?p=${new URL(input).searchParams.get('p')}&anon=true`)
  })

  it("rewrites Teams' own app hand-off redirect (msLaunch=true)", () => {
    // The Location Teams answers /meet/<id> with (curl, 2026-09-29).
    const redirect =
      'https://teams.microsoft.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F2345678901234%3Fp%3DAbCdEfGh%26anon%3Dtrue&type=meet&deeplinkId=65bc138b-2f47-45d3-92b4-1d932b81937f&directDl=true&msLaunch=true&enableMobilePage=true'
    const out = new URL(meetingBrowserUrl(redirect))
    expect(out.searchParams.get('msLaunch')).toBe('false')
    expect(out.searchParams.get('suppressPrompt')).toBe('true')
    expect(out.searchParams.get('url')).toBe('/_#/meet/2345678901234?p=AbCdEfGh&anon=true')
    expect(out.searchParams.get('deeplinkId')).toBe('65bc138b-2f47-45d3-92b4-1d932b81937f')
    // Already in-browser: left alone.
    expect(meetingBrowserUrl(out.toString())).toBe(out.toString())
  })

  it.each([
    ['meetup-join on teams.live.com', 'https://teams.live.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d'],
    ['Teams web app', 'https://teams.microsoft.com/v2/'],
    ['lookalike host', 'https://teams.microsoft.com.evil.example/meet/2345678901234?p=x'],
    ['Safe Link', 'https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fmeet%2F1'],
    ['Google Meet', 'https://meet.google.com/abc-defg-hij'],
    ['not a URL', 'zoom.us/j/81234567890'],
  ])('leaves %s unchanged', (_name, input) => {
    expect(meetingBrowserUrl(input)).toBe(input)
  })
})

describe('meetingNavigationTarget', () => {
  it('rewrites a landing-page navigation once, then lets it through (no loop)', () => {
    const seen = new Set<string>()
    const landing = 'https://zoom.us/j/81234567890?pwd=x'
    expect(meetingNavigationTarget(landing, seen)).toBe('https://app.zoom.us/wc/81234567890/join?fromPWA=1&pwd=x')
    expect(meetingNavigationTarget(landing, seen)).toBeNull()
  })

  it('ignores navigations that need no mapping', () => {
    const seen = new Set<string>()
    expect(meetingNavigationTarget('https://app.zoom.us/wc/81234567890/join?fromPWA=1', seen)).toBeNull()
    expect(meetingNavigationTarget('https://meet.google.com/abc-defg-hij', seen)).toBeNull()
    expect(seen.size).toBe(0)
  })
})

// Every origin a Zoom or Teams join runs on, as a meeting pane asks for each
// permission it needs. The browser joins meetingBrowserUrl produces must be
// on the list too.
const ZOOM_TEAMS_ORIGINS = [
  'https://zoom.us',
  'https://app.zoom.us',
  'https://us06web.zoom.us',
  'https://us05web.zoom.us',
  'https://acme.zoom.us',
  'https://zoom.com',
  'https://app.zoom.com',
  'https://teams.microsoft.com',
  'https://teams.live.com',
  'https://teams.cloud.microsoft',
]

const ASKS: Array<[string, { permission: string; mediaTypes?: string[] }]> = [
  ['mic', { permission: 'media', mediaTypes: ['audio'] }],
  ['camera', { permission: 'media', mediaTypes: ['video'] }],
  ['mic+camera', { permission: 'media', mediaTypes: ['audio', 'video'] }],
  ['check (unknown type)', { permission: 'media', mediaTypes: ['unknown'] }],
  ['screen share', { permission: 'display-capture' }],
]

describe('permissions on every Zoom/Teams origin', () => {
  const rows: Array<[string, string, { permission: string; mediaTypes?: string[] }]> = ZOOM_TEAMS_ORIGINS.flatMap((o) =>
    ASKS.map(([ask, q]) => [o, ask, q] as [string, string, typeof q]),
  )

  it.each(rows)('%s %s → allow in a meeting pane', (origin, _ask, q) => {
    expect(meetingPermission({ isMeetingPane: true, origin, ...q })).toBe('allow')
    expect(meetingPermission({ isMeetingPane: true, origin: `${origin}/some/page?x=1`, ...q })).toBe('allow')
  })

  it.each(rows)('%s %s → default in a plain web pane', (origin, _ask, q) => {
    expect(meetingPermission({ isMeetingPane: false, origin, ...q })).toBe('default')
  })

  it.each([
    'https://teams.microsoft.com.evil.example',
    'https://teams.cloud.microsoft.evil.example',
    'https://xteams.live.com',
    'https://evil.teams.live.com',
    'https://cloud.microsoft',
    'https://zoom.us.evil.example',
    'https://evilzoom.us',
    'http://app.zoom.us',
    'http://teams.microsoft.com',
  ])('%s → deny in a meeting pane', (origin) => {
    for (const [, q] of ASKS) expect(meetingPermission({ isMeetingPane: true, origin, ...q })).toBe('deny')
  })

  it('every browser join produced is an allowlisted origin', () => {
    for (const link of [
      'https://us06web.zoom.us/j/81234567890?pwd=x',
      'https://zoom.com/j/81234567890',
      TEAMS_JOIN,
      'https://teams.microsoft.com/meet/2345678901234?p=x',
      'https://teams.live.com/meet/9876543210987?p=x',
    ]) {
      expect(isMeetingOrigin(meetingBrowserUrl(link))).toBe(true)
    }
  })
})

describe('openExternal (zoommtg:/msteams: app hand-off)', () => {
  const cases: Array<[string, boolean, string, MeetingPermissionVerdict]> = [
    ['Zoom landing page in a meeting pane', true, 'https://zoom.us', 'deny'],
    ['Teams launcher in a meeting pane', true, 'https://teams.microsoft.com', 'deny'],
    ['any site in a meeting pane', true, 'https://example.com', 'deny'],
    ['plain web pane keeps today\'s behaviour', false, 'https://zoom.us', 'default'],
  ]
  it.each(cases)('%s', (_name, isMeetingPane, origin, want) => {
    expect(meetingPermission({ isMeetingPane, origin, permission: 'openExternal' })).toBe(want)
  })
})
