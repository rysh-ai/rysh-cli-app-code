// Where a meeting pane points its browser (design 043 §"Zoom and Teams in panes").
//
// The meeting link a user pastes is the one Recall's bot joins, unchanged. The
// PANE is a browser, and in a browser both Zoom and Teams links first land on
// a "launch the desktop app" page. A meeting pane must stay in the browser, so
// it opens each platform's own browser join instead:
//
//  - Zoom  /j/<id>, /wc/join/<id>, /wc/<id>/join on zoom.us / zoom.com (or one
//          subdomain) → the Zoom web client https://app.zoom.us/wc/<id>/join,
//          keeping only the passcode (pwd). Personal /my/<name> links carry no
//          meeting id and are opened as they are; their landing page's
//          "Join from your browser" works because meeting panes never hand a
//          link to the desktop app (openExternal is denied, meetingPermissions).
//  - Teams /l/meetup-join/… and /meet/<id> on teams.microsoft.com and
//          teams.live.com → the Teams launcher with msLaunch=false and
//          suppressPrompt=true, which goes straight to the in-browser
//          (guest) join. Teams itself redirects every such link to that
//          launcher with msLaunch=true (the app hand-off); this is the same URL
//          with the hand-off switched off, built the way Teams builds it.
//  - A Teams launcher URL with msLaunch=true (a redirect or a pasted launcher
//          link) → the same URL with msLaunch=false, suppressPrompt=true.
//
// Everything else — Google Meet, the Zoom web client itself, pages inside a
// call — is returned unchanged. The mapping is also applied to navigations and
// redirects of a meeting pane (webPaneManager), so a "Join" link on a landing
// page ends in the browser join too.

const ZOOM_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?zoom\.(?:us|com)$/
const ZOOM_ID_PATH = /^\/(?:j\/([0-9]{9,12})|wc\/join\/([0-9]{9,12})|wc\/([0-9]{9,12})\/join)\/?$/
const ZOOM_WEB_CLIENT = 'app.zoom.us'
const TEAMS_HOSTS = new Set(['teams.microsoft.com', 'teams.live.com'])
const TEAMS_JOIN_PATH = /^\/(l\/meetup-join|meet)\/.+/
const TEAMS_LAUNCHER = '/dl/launcher/launcher.html'

/** The browser join for a meeting link; `raw` itself when there is nothing to map. */
export function meetingBrowserUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return raw
  const host = u.hostname.toLowerCase()

  if (ZOOM_HOST.test(host)) {
    // The web client itself (and every page it moves to) is left alone.
    if (host === ZOOM_WEB_CLIENT && u.pathname.startsWith('/wc/')) return raw
    const m = ZOOM_ID_PATH.exec(u.pathname)
    if (!m) return raw
    const id = m[1] || m[2] || m[3]
    const out = new URL(`https://${ZOOM_WEB_CLIENT}/wc/${id}/join`)
    out.searchParams.set('fromPWA', '1')
    const pwd = u.searchParams.get('pwd')
    if (pwd) out.searchParams.set('pwd', pwd)
    return out.toString()
  }

  if (TEAMS_HOSTS.has(host)) {
    if (u.pathname === TEAMS_LAUNCHER) {
      if (u.searchParams.get('msLaunch') === 'false' && u.searchParams.get('suppressPrompt') === 'true') return raw
      const out = new URL(u.toString())
      out.hash = ''
      out.searchParams.set('msLaunch', 'false')
      out.searchParams.set('suppressPrompt', 'true')
      return out.toString()
    }
    const m = TEAMS_JOIN_PATH.exec(u.pathname)
    if (!m) return raw
    // meetup-join is live on teams.microsoft.com only (MeetingPlatform, rysh-cli).
    if (m[1] === 'l/meetup-join' && host !== 'teams.microsoft.com') return raw
    let path: string
    try {
      path = decodeURIComponent(u.pathname)
    } catch {
      return raw
    }
    const query = new URLSearchParams(u.search)
    const inner = query.toString()
    // Teams' own redirect adds anon=true (guest join) to the deep link.
    const deepLink = `/_#${path}?${inner}${query.has('anon') ? '' : `${inner ? '&' : ''}anon=true`}`
    const out = new URL(`https://${host}${TEAMS_LAUNCHER}`)
    out.searchParams.set('url', deepLink)
    out.searchParams.set('type', m[1] === 'meet' ? 'meet' : 'meetup-join')
    out.searchParams.set('directDl', 'true')
    out.searchParams.set('msLaunch', 'false')
    out.searchParams.set('enableMobilePage', 'true')
    out.searchParams.set('suppressPrompt', 'true')
    return out.toString()
  }

  return raw
}

/**
 * For a meeting pane's main-frame navigation or redirect to `url`: the browser
 * join to load instead, or null to let the navigation proceed. Each source URL
 * is rewritten at most once per pane (`rewritten` holds them), so a platform
 * that bounces the browser join back to its landing page ends on the page,
 * never in a loop.
 */
export function meetingNavigationTarget(url: string, rewritten: Set<string>): string | null {
  const target = meetingBrowserUrl(url)
  if (target === url || rewritten.has(url)) return null
  rewritten.add(url)
  return target
}
