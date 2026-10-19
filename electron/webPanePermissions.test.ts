import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webPanePermission } from './webPanePermissions'

// E-76: a plain web pane's `persist:<profile>` partition had no permission
// handler, so Electron granted everything. Now every web-pane partition carries
// one set of handlers (meeting D8 first, then this deny-by-default policy).

describe('webPanePermission', () => {
  it.each([
    'media',
    'display-capture',
    'geolocation',
    'notifications',
    'midi',
    'midiSysex',
    'hid',
    'serial',
    'usb',
    'pointerLock',
    'keyboardLock',
    'openExternal',
    'clipboard-read',
    'idle-detection',
    'window-management',
    'unknown',
    '',
  ])('denies %s', (p) => {
    expect(webPanePermission(p)).toBe(false)
  })

  it.each(['fullscreen', 'clipboard-sanitized-write'])('allows %s', (p) => {
    expect(webPanePermission(p)).toBe(true)
  })
})

// --- Wiring: WebPaneManager installs the handlers on every web-pane partition ---

type Handlers = {
  request?: (wc: unknown, permission: string, cb: (ok: boolean) => void, details: unknown) => void
  check?: (wc: unknown, permission: string, origin: string, details: unknown) => boolean
  display?: (req: unknown, cb: (r: unknown) => void) => void
  device?: (details: unknown) => boolean
  installs: number
}

const state = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  handlers: new Map<string, Handlers>(),
}))

// Any property is a no-op function returning the same proxy, so the parts of
// WebPaneManager this test does not care about (navigation listeners, CDP, zoom)
// run without a real Electron. `then` is absent so an awaited call resolves.
function noop(): any {
  const target = function () {}
  const p: any = new Proxy(target, {
    get: (_t, k) => (k === 'then' ? undefined : p),
    apply: () => p,
  })
  return p
}

vi.mock('electron', () => {
  function fakeSession(name: string) {
    const h: Handlers = { installs: 0 }
    state.handlers.set(name, h)
    return {
      setUserAgent: () => {},
      webRequest: { onBeforeSendHeaders: () => {} },
      cookies: { set: async () => {} },
      setPermissionRequestHandler: (fn: Handlers['request']) => {
        h.installs++
        h.request = fn
      },
      setPermissionCheckHandler: (fn: Handlers['check']) => {
        h.check = fn
      },
      setDisplayMediaRequestHandler: (fn: Handlers['display']) => {
        h.display = fn
      },
      setDevicePermissionHandler: (fn: Handlers['device']) => {
        h.device = fn
      },
    }
  }
  class WebContentsView {
    webContents = noop()
    setBounds() {}
    setVisible() {}
  }
  return {
    BrowserWindow: class {},
    WebContentsView,
    desktopCapturer: { getSources: async () => [] },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    webContents: { fromFrame: () => undefined },
    session: {
      fromPartition: (name: string) => {
        if (!state.sessions.has(name)) state.sessions.set(name, fakeSession(name))
        return state.sessions.get(name)
      },
    },
  }
})

// spoofChromeIdentity reads the Chromium version Electron reports.
if (!process.versions.chrome) Object.defineProperty(process.versions, 'chrome', { value: '140.0.0.0' })

const { WebPaneManager } = await import('./webPaneManager')

function manager() {
  const win = { contentView: { addChildView: () => {} }, isDestroyed: () => false }
  return new WebPaneManager(win as never)
}

function ask(h: Handlers, wc: unknown, permission: string, details: unknown): boolean {
  let got: boolean | undefined
  h.request!(wc, permission, (ok) => (got = ok), details)
  return got!
}

const MIC = { requestingUrl: 'https://meet.google.com/abc-defg-hij', mediaTypes: ['audio', 'video'] }

describe('WebPaneManager permission wiring', () => {
  beforeEach(() => {
    state.sessions.clear()
    state.handlers.clear()
  })

  it('a plain web pane partition denies camera/mic, geolocation, notifications, devices', () => {
    const m = manager()
    m.create('p1', 'https://example.com', 'work')
    const h = state.handlers.get('persist:work')!
    expect(h, 'handlers installed on the web pane partition').toBeDefined()
    const wc = (m as any).panes.get('p1').view.webContents
    expect(ask(h, wc, 'media', MIC)).toBe(false)
    expect(ask(h, wc, 'geolocation', { requestingUrl: 'https://example.com' })).toBe(false)
    expect(ask(h, wc, 'notifications', { requestingUrl: 'https://example.com' })).toBe(false)
    expect(ask(h, wc, 'openExternal', { requestingUrl: 'https://example.com' })).toBe(false)
    expect(ask(h, wc, 'fullscreen', { requestingUrl: 'https://example.com' })).toBe(true)
    expect(h.check!(wc, 'media', 'https://example.com', { mediaType: 'audio' })).toBe(false)
    expect(h.device!({})).toBe(false)
  })

  it('a meeting pane on a partition a web pane already holds keeps D8, and the web pane stays denied', () => {
    const m = manager()
    m.create('web', 'https://meet.google.com/abc-defg-hij', 'work')
    m.create('mtg', 'https://meet.google.com/abc-defg-hij', 'work', undefined, { meeting: true })
    const h = state.handlers.get('persist:work')!
    expect(h.installs, 'one handler set per session, not replaced').toBe(1)
    const webWC = (m as any).panes.get('web').view.webContents
    const mtgWC = (m as any).panes.get('mtg').view.webContents
    expect(ask(h, mtgWC, 'media', MIC)).toBe(true)
    expect(ask(h, webWC, 'media', MIC)).toBe(false)
    // D8 leaves these "default" for the meeting pane: the web-pane policy, not Electron's grant
    expect(ask(h, mtgWC, 'notifications', { requestingUrl: 'https://meet.google.com' })).toBe(false)
    expect(ask(h, mtgWC, 'geolocation', { requestingUrl: 'https://meet.google.com' })).toBe(false)
    expect(ask(h, mtgWC, 'fullscreen', { requestingUrl: 'https://meet.google.com' })).toBe(true)
    // a popup (OAuth) on the same partition is not a meeting pane
    expect(ask(h, noop(), 'media', MIC)).toBe(false)
  })

  it('importCookies on a partition with no pane yet installs the handlers too', async () => {
    const m = manager()
    await m.importCookies('personal', [])
    const h = state.handlers.get('persist:personal')!
    expect(h?.request, 'handlers installed by importCookies').toBeDefined()
    expect(ask(h, noop(), 'media', MIC)).toBe(false)
    m.create('p2', 'https://example.com', 'personal')
    expect(h.installs).toBe(1)
  })
})
