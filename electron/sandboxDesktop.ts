import type { BrowserWindowConstructorOptions } from 'electron'
import { isSandboxDesktopLinkArg, parseSandboxDesktopLink, type SandboxDesktopTarget } from '../src/utils/sandboxDesktopLink'

/**
 * rysh Sandboxes (rr-order-154 C8): a sandbox's desktop in the desktop app.
 *
 * The app never talks to rysh-server itself (design 037) and holds no new credential. It
 * opens the rysh.ai viewer page (/workspaces/:wsID/sandboxes/:sandboxID/desktop, the web
 * app's SandboxDesktop: noVNC over the same-host WebSocket with a single-use ticket) in a
 * locked-down window, where the person signs in to rysh.ai exactly as on the web.
 * Dark: off unless RYSH_EXPERIMENTAL_SANDBOXES is exactly "1".
 */
export const SANDBOX_DESKTOP_PARTITION = 'persist:rysh-sandbox-desktop'

/**
 * The only origin the window ever loads (desktop's shaping note 11-09): the link may name
 * a server, but anything other than exactly this origin is refused, with no question.
 */
export const VIEWER_ORIGIN = 'https://rysh.ai'

/** Cold-start links (Linux passes them in argv) that belong to the sandbox window. */
export function sandboxDesktopLinksInArgv(argv: string[]): string[] {
  return argv.filter(isSandboxDesktopLinkArg)
}

export function sandboxesEnabled(env: Record<string, string | undefined>): boolean {
  return env.RYSH_EXPERIMENTAL_SANDBOXES === '1'
}

export function viewerUrl(t: SandboxDesktopTarget): string {
  const origin = VIEWER_ORIGIN
  const ws = encodeURIComponent(t.workspaceID)
  const sbx = encodeURIComponent(t.sandboxID)
  return `${origin}/workspaces/${ws}/sandboxes/${sbx}/desktop?mode=${t.mode}`
}

export function windowOptions(title: string): BrowserWindowConstructorOptions & {
  webPreferences: NonNullable<BrowserWindowConstructorOptions['webPreferences']>
} {
  return {
    title,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      partition: SANDBOX_DESKTOP_PARTITION,
    },
  }
}

interface GuardableContents {
  setWindowOpenHandler(h: (d: { url: string }) => { action: 'deny' }): void
  on(event: 'will-navigate', h: (e: { preventDefault(): void }, url: string) => void): void
  session: {
    setPermissionRequestHandler(h: (wc: unknown, permission: string, cb: (ok: boolean) => void) => void): void
    setPermissionCheckHandler(h: (wc: unknown, permission: string) => boolean): void
  }
}

const isHttps = (u: string) => {
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}
const sameOrigin = (u: string, origin: string) => {
  try {
    return new URL(u).origin === origin
  } catch {
    return false
  }
}

/** No popups (an https one goes to the system browser), navigation stays on the server, no permissions. */
export function guardWebContents(wc: GuardableContents, origin: string, openExternal: (url: string) => void): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttps(url)) openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (sameOrigin(url, origin)) return
    e.preventDefault()
    if (isHttps(url)) openExternal(url)
  })
  wc.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  wc.session.setPermissionCheckHandler(() => false)
}

export interface OpenDeps {
  env: Record<string, string | undefined>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BrowserWindow: new (opts: BrowserWindowConstructorOptions) => { webContents: any; loadURL(u: string): Promise<void> }
  openExternal: (url: string) => void
}

export async function openSandboxDesktop(link: string, deps: OpenDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!sandboxesEnabled(deps.env)) return { ok: false, error: 'Sandboxes are not enabled in this app.' }
  const t = parseSandboxDesktopLink(link)
  if (!t) return { ok: false, error: 'That is not a sandbox desktop link.' }
  let origin = ''
  try {
    const u = new URL(t.server)
    origin = u.username || u.password ? '' : u.origin
  } catch {
    origin = ''
  }
  if (origin !== VIEWER_ORIGIN) return { ok: false, error: `Sandbox desktops open only on ${VIEWER_ORIGIN}.` }
  const win = new deps.BrowserWindow(windowOptions(`Sandbox ${t.sandboxID}`))
  guardWebContents(win.webContents, VIEWER_ORIGIN, deps.openExternal)
  await win.loadURL(viewerUrl(t))
  return { ok: true }
}
