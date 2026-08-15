import { BrowserWindow, WebContentsView, session } from 'electron'

// Web panes render desktop pages at a fixed reference layout width, then scale
// the whole page (Chromium page-zoom) so that full-width layout fits the pane.
// setZoomFactor(z) makes the page's CSS layout viewport width = physicalWidth / z,
// so z = paneWidth / REFERENCE_WIDTH renders a ~REFERENCE_WIDTH-wide desktop layout
// shrunk to fit the pane — nothing is clipped horizontally, so the browser-agent's
// screenshots (capturePage of the viewport) capture the whole page width even when
// the pane is small. Capped at 1 (never enlarge) and floored at MIN_ZOOM so a tiny
// pane stays legible (below the floor the page may overflow slightly rather than
// becoming unreadably small).
const WEB_FIT_REFERENCE_WIDTH = 1280
const WEB_FIT_MIN_ZOOM = 0.3

/**
 * Represents the bounds of a web pane within the main window.
 */
export interface WebPaneBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Status information for a web pane, sent to the renderer.
 */
export interface WebPaneStatus {
  paneId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/**
 * One cookie to import into a profile's session partition. Shape matches the
 * Go `msg.ImportCookie` wire payload (from CDP Storage.getCookies), which is
 * why fields are snake-free and sameSite is the CDP TitleCase form.
 */
export interface ImportCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number // unix seconds; <= 0 means a session cookie
  httpOnly: boolean
  secure: boolean
  sameSite: string // "Strict" | "Lax" | "None" | ""
}

interface WebPaneEntry {
  view: WebContentsView
  bounds: WebPaneBounds
  paneId: string
  // The partition name (profile) this view is bound to. Used to detect a
  // profile change (`##mode new web --profile <other>`) so the view can be
  // recreated against the new persistent partition instead of silently
  // reattaching the old one.
  profile: string
}

/**
 * WebPaneManager manages BrowserView/WebContentsView instances for web-mode panes.
 *
 * Each web pane gets an isolated Chromium session (via session partitions),
 * independent cookies/localStorage, and its own navigation history.
 *
 * Note: Electron 29+ deprecates BrowserView in favor of WebContentsView.
 * This implementation uses WebContentsView for forward compatibility.
 */
export class WebPaneManager {
  private window: BrowserWindow
  private panes: Map<string, WebPaneEntry> = new Map()
  private statusCallback: ((status: WebPaneStatus) => void) | null = null
  // Sessions whose request headers we've already patched to look like real
  // Chrome (see spoofChromeIdentity). Keyed weakly so partition sessions can be
  // GC'd; prevents stacking duplicate onBeforeSendHeaders listeners when several
  // panes share one profile partition.
  private uaPatchedSessions = new WeakSet<Electron.Session>()
  // Panes scheduled for delayed teardown by syncAlive. A web view is destroyed
  // only after its pane has stayed absent for a grace period, so a transient
  // snapshot that momentarily omits the pane (focus/layout churn, a brief
  // re-restore) doesn't tear down and reload the live browser.
  private pendingDestroy = new Map<string, ReturnType<typeof setTimeout>>()
  // When true, ALL web views are hidden (setVisible false) because a DOM modal
  // (e.g. the approval dialog) is up — a native WebContentsView would otherwise
  // render above it. show()/create() honour this so a pane activated mid-modal
  // stays hidden until setSuppressed(false). See setSuppressed.
  private suppressed = false

  constructor(window: BrowserWindow) {
    this.window = window
  }

  /**
   * Make a web-pane session's network identity look like plain Google Chrome
   * instead of Electron, so third-party OAuth (notably "Sign in with Google")
   * doesn't reject it as a "disallowed user agent" / "this browser or app may
   * not be secure". Beyond the UA string, Google inspects the Sec-CH-UA
   * client-hint brands — Electron advertises an "Electron" brand and omits
   * "Google Chrome" — so we rewrite both on every request. Registered on the
   * session, so the pane's view AND the OAuth popups (which share the session)
   * are covered. Idempotent per session.
   */
  private spoofChromeIdentity(ses: Electron.Session): void {
    if (this.uaPatchedSessions.has(ses)) return
    this.uaPatchedSessions.add(ses)

    const { ua: cleanUA, chua: brands, chuaFull: brandsFull } = this.chromeIdentity()

    // Layer 1 — the JS-visible identity. onBeforeSendHeaders (below) only
    // rewrites the outgoing *network* User-Agent; the page's own
    // `navigator.userAgent` would still read "…Electron/…". Google's sign-in
    // gate ("this browser or app may not be secure") runs a CLIENT-SIDE check on
    // navigator.userAgent, so header spoofing alone doesn't clear it.
    // setUserAgent overrides the UA the renderer exposes to JS (and the default
    // request UA) for the whole session — covering the pane's view AND the OAuth
    // popups that share this session.
    ses.setUserAgent(cleanUA)

    // Layer 2 — the network headers (UA + Sec-CH-UA brand hints). Electron
    // advertises an "Electron" brand and omits "Google Chrome" in Sec-CH-UA, so
    // rewrite both on every request.
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const h = details.requestHeaders
      let hadCHUA = false
      let hadCHUAFull = false
      for (const k of Object.keys(h)) {
        const lk = k.toLowerCase()
        if (lk === 'user-agent') delete h[k]
        else if (lk === 'sec-ch-ua') {
          delete h[k]
          hadCHUA = true
        } else if (lk === 'sec-ch-ua-full-version-list') {
          delete h[k]
          hadCHUAFull = true
        }
      }
      h['User-Agent'] = cleanUA
      // Only re-add brand hints to requests that already sent them (secure
      // contexts), to avoid attaching client hints where a browser wouldn't.
      if (hadCHUA) h['sec-ch-ua'] = brands
      if (hadCHUAFull) h['sec-ch-ua-full-version-list'] = brandsFull
      callback({ requestHeaders: h })
    })
  }

  /**
   * The plain-Chrome identity we present to third-party sign-in gates: a UA
   * string, matching Sec-CH-UA header values, and the userAgentMetadata that
   * backs `navigator.userAgentData`. Derived from the bundled Chromium version
   * so the numbers stay real. Shared by spoofChromeIdentity (headers/session UA)
   * and applyIdentityOverride (the CDP override that reaches navigator.userAgentData).
   */
  private chromeIdentity(): {
    ua: string
    chua: string
    chuaFull: string
    metadata: Record<string, unknown>
  } {
    const full = process.versions.chrome
    const major = full.split('.')[0]
    const ua =
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${full} Safari/537.36`
    const chua = `"Not/A)Brand";v="8", "Chromium";v="${major}", "Google Chrome";v="${major}"`
    const chuaFull =
      `"Not/A)Brand";v="8.0.0.0", "Chromium";v="${full}", "Google Chrome";v="${full}"`
    const metadata = {
      brands: [
        { brand: 'Not/A)Brand', version: '8' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
      ],
      fullVersionList: [
        { brand: 'Not/A)Brand', version: '8.0.0.0' },
        { brand: 'Chromium', version: full },
        { brand: 'Google Chrome', version: full },
      ],
      fullVersion: full,
      platform: 'macOS',
      platformVersion: '14.5.0',
      architecture: process.arch === 'arm64' ? 'arm' : 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    }
    return { ua, chua, chuaFull, metadata }
  }

  /**
   * Deep identity override via CDP. The header/session spoof in
   * spoofChromeIdentity fixes the network UA and `navigator.userAgent`, but NOT
   * `navigator.userAgentData` — the Sec-CH-UA JavaScript API, which Electron
   * still populates with an "Electron" brand. Google's "this browser or app may
   * not be secure" gate reads it client-side, so the block persists on header
   * spoofing alone. Emulation.setUserAgentOverride with userAgentMetadata (the
   * same call Puppeteer's page.setUserAgent uses) rewrites the UA string AND
   * navigator.userAgentData for this webContents and its subframes. Must be
   * applied BEFORE the first navigation so the initial document sees it; the
   * debugger stays attached so the override survives later navigations.
   */
  private async applyIdentityOverride(contents: Electron.WebContents): Promise<void> {
    const { ua, metadata } = this.chromeIdentity()
    // Network-layer UA (request header + Electron's default), belt-and-suspenders
    // alongside the session header rewrite in spoofChromeIdentity.
    try {
      contents.setUserAgent(ua)
    } catch {
      /* view gone */
    }
    try {
      const dbg = contents.debugger
      if (!dbg.isAttached()) dbg.attach('1.3')
      await dbg.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: ua,
        acceptLanguage: 'en-US,en',
        platform: 'macOS',
        userAgentMetadata: metadata,
      })
      // The authoritative JS-identity fix. Emulation.setUserAgentOverride does
      // NOT reliably update navigator.userAgent / navigator.userAgentData for a
      // WebContentsView (confirmed: bot.sannysoft still read "Electron" in the UA
      // while webdriver was already false). So we redefine them in the MAIN world
      // with a document-start script — the same mechanism that neutralised
      // navigator.webdriver. Runs on EVERY navigation, so it survives the
      // cross-origin hop to accounts.google.com.
      await dbg.sendCommand('Page.enable')
      await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: this.identityInitScript(),
      })
    } catch (err) {
      // A debugger conflict (e.g. DevTools already open) or a torn-down view:
      // fall back to the header/session spoof, which still covers most cases.
      console.error('[webPane] identity override (CDP) failed:', err)
    }
  }

  /**
   * The main-world document-start script that pins the JS-visible browser
   * identity to plain Chrome: navigator.userAgent, navigator.userAgentData
   * (incl. the async getHighEntropyValues), and navigator.webdriver = false.
   * Built from chromeIdentity() so it matches the header/UA spoof exactly.
   */
  private identityInitScript(): string {
    const { ua, metadata } = this.chromeIdentity()
    const m = metadata as {
      brands: unknown
      fullVersionList: unknown
      fullVersion: string
      platform: string
      platformVersion: string
      architecture: string
      model: string
      mobile: boolean
      bitness: string
      wow64: boolean
    }
    return `(() => {
  const def = (o, p, v) => { try { Object.defineProperty(o, p, { get: () => v, configurable: true }); } catch (e) {} };
  def(navigator, 'webdriver', false);
  def(navigator, 'userAgent', ${JSON.stringify(ua)});
  def(navigator, 'appVersion', ${JSON.stringify(ua.replace('Mozilla/', ''))});
  const brands = ${JSON.stringify(m.brands)};
  const fullVersionList = ${JSON.stringify(m.fullVersionList)};
  const uad = {
    brands: brands,
    mobile: ${JSON.stringify(m.mobile)},
    platform: ${JSON.stringify(m.platform)},
    getHighEntropyValues: () => Promise.resolve({
      architecture: ${JSON.stringify(m.architecture)},
      bitness: ${JSON.stringify(m.bitness)},
      brands: brands,
      fullVersionList: fullVersionList,
      mobile: ${JSON.stringify(m.mobile)},
      model: ${JSON.stringify(m.model)},
      platform: ${JSON.stringify(m.platform)},
      platformVersion: ${JSON.stringify(m.platformVersion)},
      uaFullVersion: ${JSON.stringify(m.fullVersion)},
      wow64: ${JSON.stringify(m.wow64)}
    }),
    toJSON: () => ({ brands: brands, mobile: ${JSON.stringify(m.mobile)}, platform: ${JSON.stringify(m.platform)} })
  };
  def(navigator, 'userAgentData', uad);
})();`
  }

  /**
   * Update the parent window reference (e.g., after window recreation on macOS).
   */
  setWindow(window: BrowserWindow): void {
    this.window = window

    // Re-attach existing views to the new window
    for (const entry of this.panes.values()) {
      this.window.contentView.addChildView(entry.view)
      entry.view.setBounds(entry.bounds)
    }
  }

  /**
   * The host window's own webContents — the renderer drawing the pane grid, as
   * opposed to any embedded page. Used to give the keyboard back after an
   * agent-driven browser action had to focus a page to inject trusted input.
   */
  getHostWebContents(): Electron.WebContents | null {
    return this.window?.webContents ?? null
  }

  /**
   * Register a callback to receive web pane status updates.
   */
  onStatusUpdate(callback: (status: WebPaneStatus) => void): void {
    this.statusCallback = callback
  }

  /**
   * Create a new web pane with an isolated session.
   */
  create(paneId: string, url: string, profile: string, bounds?: WebPaneBounds): void {
    // Persistent, named session partition keyed by the rysh-cli profile name so
    // panes (and restarts) bound to the same profile share cookies/login state.
    // The partition lives under Electron's default (stable) userData/Partitions
    // directory, so a logged-in session (e.g. gmail.com) survives app restarts
    // and mode-cycling. Profiles are app-global by name: `--profile work` and
    // `--profile personal` keep separate cookie jars; the same name re-attaches
    // to the same jar every time.
    const partitionName = profile && profile.trim() !== '' ? profile : `pane-${paneId}`

    // A (re)create cancels any scheduled teardown for this pane.
    const pending = this.pendingDestroy.get(paneId)
    if (pending) {
      clearTimeout(pending)
      this.pendingDestroy.delete(paneId)
    }

    const existing = this.panes.get(paneId)
    if (existing) {
      if (existing.profile === partitionName) {
        // Same profile: this is a remount (fullscreen toggle, stack rotation, or
        // cycling away from web mode and back). Re-show the SAME live view
        // (preserving the page, navigation history and session) instead of
        // recreating it and reloading. The view was only hidden (setVisible
        // false) on detach — never removed from the hierarchy — so its rendered
        // surface is retained and reappears without a blank repaint. Bring it to
        // front and re-apply bounds (the ResizeObserver also corrects them).
        this.window.contentView.addChildView(existing.view)
        existing.view.setVisible(!this.suppressed)
        if (bounds) {
          existing.bounds = bounds
          existing.view.setBounds(bounds)
        }
        this.applyFitZoom(existing)
        return
      }
      // Different profile (e.g. `##mode new web --profile <other>` rebound this
      // pane): the partition must change, so tear down the old view and fall
      // through to build a fresh one against the new persistent partition.
      this.destroy(paneId)
    }

    const partition = `persist:${partitionName}`
    const ses = session.fromPartition(partition)

    // Present a plain-Chrome identity (UA + Sec-CH-UA brands) on this session so
    // embedded OAuth (e.g. Google sign-in on claude.ai) isn't blocked as a
    // disallowed user agent. Done before the first load; covers OAuth popups too
    // (they share this session).
    this.spoofChromeIdentity(ses)

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Allow web content to function normally
        webSecurity: true,
        allowRunningInsecureContent: false,
        // Chromium auto-focuses a WebContentsView on every navigation commit,
        // which on macOS raises the whole app above whatever the user is
        // working in (electron#42578): any page change in an embedded browser
        // (redirect, auto-refresh, AI-driven browsing) yanked Rysh over e.g.
        // the user's terminal. Requires Electron ≥ 40.
        focusOnNavigation: false,
      },
    })

    // Keep the page compositing even when not focused/occluded, so capturePage()
    // (used by the browser-agent's screenshot action) doesn't hang waiting for a
    // frame on a backgrounded WebContentsView.
    view.webContents.setBackgroundThrottling(false)

    const defaultBounds: WebPaneBounds = bounds || { x: 0, y: 0, width: 800, height: 600 }

    // Add the view to the window
    this.window.contentView.addChildView(view)
    view.setBounds(defaultBounds)
    // Stay hidden if a modal is currently suppressing web views.
    if (this.suppressed) view.setVisible(false)

    // Store the entry
    const entry: WebPaneEntry = { view, bounds: defaultBounds, paneId, profile: partitionName }
    this.panes.set(paneId, entry)

    // Register navigation event handlers
    this.registerEventHandlers(paneId, view)

    // Apply the deep identity override (UA + navigator.userAgentData via CDP)
    // BEFORE the first navigation, THEN load — so the initial document already
    // sees a plain-Chrome identity and Google's sign-in gate doesn't fire. The
    // header/session spoof above covers requests; this covers the client-side JS
    // check. If the override can't attach, we still load (headers are patched).
    this.applyIdentityOverride(view.webContents).finally(() => {
      view.webContents.loadURL(url).catch((err) => {
        console.error(`[webPane:${paneId}] Failed to load URL ${url}:`, err)
      })
    })

    console.log(`[webPane] Created pane ${paneId} → ${url}`)
  }

  /**
   * Detach a web pane's view from the window WITHOUT destroying it. Used on React
   * unmount (fullscreen toggle, stack rotation, OR cycling away from web mode):
   * the view is hidden but kept alive — with its page, history and session — so
   * remounting (cycling back to web) re-attaches the same live page. The real
   * teardown happens in syncAlive()/destroy() only when web is disabled or the
   * pane is closed, NOT on a timer (cycling away for any length of time must not
   * lose the page).
   */
  detach(paneId: string): void {
    const entry = this.panes.get(paneId)
    if (!entry) return
    // Hide in place rather than removeChildView: pulling a WebContentsView out
    // of the window's view tree discards its compositor surface, so re-adding it
    // (cycling back to web mode) shows a blank white frame until it repaints.
    // setVisible(false) keeps the view mounted and its rendered page retained,
    // so re-showing it is instant and lossless.
    entry.view.setVisible(false)
  }

  /**
   * Destroy native views for panes NOT in keepIds. Called by the renderer on
   * every snapshot with the set of panes that still have web enabled (a web
   * profile bound). This is the real GC: a view is torn down when its pane is
   * closed (gone from the snapshot) or web mode is disabled (##mode delete web),
   * while cycling input modes — which keeps the web binding — preserves it.
   */
  syncAlive(keepIds: string[]): void {
    const keep = new Set(keepIds)
    // A pane that's back in the keep set: cancel any scheduled teardown.
    for (const [paneId, timer] of this.pendingDestroy) {
      if (keep.has(paneId)) {
        clearTimeout(timer)
        this.pendingDestroy.delete(paneId)
      }
    }
    // A pane no longer present: schedule (don't immediately perform) teardown.
    // The view is already hidden (detach on React unmount); we keep it alive for
    // the grace period so a quick reappearance re-attaches the SAME live page
    // instead of destroying + reloading it. Only sustained absence tears down.
    for (const paneId of [...this.panes.keys()]) {
      if (keep.has(paneId) || this.pendingDestroy.has(paneId)) continue
      const timer = setTimeout(() => {
        this.pendingDestroy.delete(paneId)
        this.destroy(paneId)
      }, 5000)
      this.pendingDestroy.set(paneId, timer)
    }
  }

  /**
   * Destroy a web pane and clean up resources.
   */
  destroy(paneId: string): void {
    const pending = this.pendingDestroy.get(paneId)
    if (pending) {
      clearTimeout(pending)
      this.pendingDestroy.delete(paneId)
    }
    const entry = this.panes.get(paneId)
    if (!entry) return

    this.window.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
    this.panes.delete(paneId)

    console.log(`[webPane] Destroyed pane ${paneId}`)
  }

  /**
   * Destroy all web panes.
   */
  destroyAll(): void {
    for (const paneId of this.panes.keys()) {
      this.destroy(paneId)
    }
  }

  /**
   * Update the bounds (position and size) of a web pane.
   */
  setBounds(paneId: string, bounds: WebPaneBounds): void {
    const entry = this.panes.get(paneId)
    if (!entry) return

    // The renderer measures the page-area container with getBoundingClientRect(),
    // which returns CSS pixels in the host window's (possibly zoomed) layout
    // viewport. WebContentsView.setBounds() expects DIP (zoom-independent), so when
    // the UI is zoomed (View ▸ Zoom In/Out / Cmd +/- → zoomFactor != 1) the raw CSS
    // values land the native view in the wrong place and at the wrong size — it
    // floats off its pane and overflows the borders. Convert CSS px -> DIP
    // (DIP = CSS * zoomFactor); a no-op at zoomFactor 1.
    const dip = this.toDIP(bounds)
    entry.bounds = dip
    entry.view.setBounds(dip)
    // Re-fit the page to the new width so a resized (or small) pane shrinks the
    // page instead of clipping it behind a horizontal scrollbar.
    this.applyFitZoom(entry)
  }

  // toDIP converts renderer CSS-pixel bounds (from getBoundingClientRect, measured
  // in the host window's zoomed layout viewport) to device-independent pixels, which
  // is what WebContentsView.setBounds() expects. DIP = CSS * hostZoomFactor. Returns
  // the input unchanged at zoomFactor 1 (the common case).
  private toDIP(bounds: WebPaneBounds): WebPaneBounds {
    let zf = 1
    try {
      zf = this.window.webContents.getZoomFactor() || 1
    } catch {
      /* window gone */
    }
    if (zf === 1) return bounds
    return {
      x: Math.round(bounds.x * zf),
      y: Math.round(bounds.y * zf),
      width: Math.floor(bounds.width * zf),
      height: Math.floor(bounds.height * zf),
    }
  }

  // zoomForWidth maps a pane content width to a page-zoom factor (see
  // WEB_FIT_REFERENCE_WIDTH). Returns 1 for any pane at/above the reference width.
  private zoomForWidth(width: number): number {
    if (!width || width <= 0) return 1
    return Math.max(WEB_FIT_MIN_ZOOM, Math.min(1, width / WEB_FIT_REFERENCE_WIDTH))
  }

  // applyFitZoom shrinks the page to fit the pane's current width. Safe to call
  // any time on a live view; it's re-applied on resize and after navigation
  // (Chromium resets zoom per-origin, so a fresh load needs it re-applied).
  private applyFitZoom(entry?: WebPaneEntry): void {
    if (!entry) return
    try {
      entry.view.webContents.setZoomFactor(this.zoomForWidth(entry.bounds.width))
    } catch {
      /* view torn down */
    }
  }

  /**
   * Navigate a web pane to a new URL.
   */
  navigate(paneId: string, url: string): void {
    const entry = this.panes.get(paneId)
    if (!entry) return

    entry.view.webContents.loadURL(url).catch((err) => {
      console.error(`[webPane:${paneId}] Navigation failed:`, err)
    })
  }

  /**
   * Navigate back in the web pane's history.
   */
  goBack(paneId: string): void {
    const entry = this.panes.get(paneId)
    if (!entry) return

    // navigationHistory API: the flat canGoBack()/goBack() webContents methods
    // were removed in newer Electron (deprecated E33, gone by E41).
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      entry.view.webContents.navigationHistory.goBack()
    }
  }

  /**
   * Navigate forward in the web pane's history.
   */
  goForward(paneId: string): void {
    const entry = this.panes.get(paneId)
    if (!entry) return

    if (entry.view.webContents.navigationHistory.canGoForward()) {
      entry.view.webContents.navigationHistory.goForward()
    }
  }

  /**
   * Reload the current page in a web pane.
   */
  reload(paneId: string): void {
    const entry = this.panes.get(paneId)
    if (!entry) return

    entry.view.webContents.reload()
  }

  /**
   * Toggle Chrome DevTools for a web pane.
   */
  toggleDevTools(paneId: string): void {
    const entry = this.panes.get(paneId)
    if (!entry) return

    // applyIdentityOverride keeps the CDP debugger attached; Chromium won't let
    // the DevTools frontend attach alongside it. Release it so DevTools opens —
    // the UA override reverts to the header/session spoof until the next
    // navigation or recreate re-applies the deep override.
    try {
      const dbg = entry.view.webContents.debugger
      if (dbg.isAttached()) dbg.detach()
    } catch {
      /* nothing attached / view gone */
    }
    entry.view.webContents.toggleDevTools()
  }

  /**
   * Get the current page content (title + text) from a web pane.
   */
  async getPageContent(paneId: string): Promise<{ title: string; text: string; url: string } | null> {
    const entry = this.panes.get(paneId)
    if (!entry) return null

    try {
      const title = entry.view.webContents.getTitle()
      const url = entry.view.webContents.getURL()
      const text = await entry.view.webContents.executeJavaScript(
        'document.body.innerText.substring(0, 50000)'
      )
      return { title, text, url }
    } catch {
      return null
    }
  }

  /**
   * Capture a screenshot of a web pane.
   */
  async captureScreenshot(paneId: string): Promise<Buffer | null> {
    const entry = this.panes.get(paneId)
    if (!entry) return null

    try {
      const image = await entry.view.webContents.capturePage()
      return image.toPNG()
    } catch {
      return null
    }
  }

  /**
   * Run arbitrary JavaScript in the page's main world and return the last
   * expression's value. Used by the browser-action executor for selector-based
   * actions (click/type/getText/eval). The result must be JSON-serializable.
   */
  /**
   * Trusted-input channel: the pane's webContents, for
   * webContents.sendInputEvent / insertText. Browser-level injection is the
   * ONLY way to produce isTrusted:true events in a WebContentsView —
   * synthetic dispatchEvent/execCommand input is ignored (or reverted) by
   * controlled contenteditable editors (Draft.js / ProseMirror, e.g. Medium).
   */
  getWebContents(paneId: string): Electron.WebContents | null {
    const entry = this.panes.get(paneId)
    return entry ? entry.view.webContents : null
  }

  /**
   * DevTools-protocol input channel (webContents.debugger). Input MUST go
   * through CDP Input.* commands: Electron's sendInputEvent edits the DOM via
   * Blink's low-level path but controlled editors (Medium's Draft/ProseMirror)
   * never register it in their model — text appears in textContent yet the
   * editor still renders its placeholder and publishes empty. CDP-dispatched
   * events are processed by the full event pipeline (verified against Medium
   * by the title lab on the headless path, which uses the same protocol).
   */
  async cdpSend(
    paneId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'no such web pane' }
    const dbg = entry.view.webContents.debugger
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3')
      } catch (err: any) {
        return { ok: false, error: 'cdp attach: ' + (err?.message || String(err)) }
      }
    }
    try {
      const result = await dbg.sendCommand(method, params)
      return { ok: true, result }
    } catch (err: any) {
      return { ok: false, error: method + ': ' + (err?.message || String(err)) }
    }
  }


  async executeJavaScript(
    paneId: string,
    code: string
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const entry = this.panes.get(paneId)
    if (!entry) return { ok: false, error: 'no such web pane' }
    try {
      const result = await entry.view.webContents.executeJavaScript(code, /* userGesture */ true)
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Capture a JPEG screenshot as base64 (no data-URL prefix). JPEG q40 keeps the
   * payload under the NATS ~1 MB message limit used by the browser_action tool.
   */
  async captureScreenshotJPEG(paneId: string, quality = 40): Promise<string | null> {
    const entry = this.panes.get(paneId)
    if (!entry) return null
    try {
      // Race capturePage with a timeout: it can hang indefinitely on an
      // occluded/backgrounded WebContentsView.
      let image = await Promise.race([
        entry.view.webContents.capturePage(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ])
      if (!image) return null
      // Cap the width (Retina capture is 2×) so the base64 stays well under the
      // NATS payload limit — the agent doesn't need a full-res image.
      const size = image.getSize()
      if (size.width > 1280) {
        image = image.resize({ width: 1280 })
      }
      // Deliberately JPEG (not PNG): q40 keeps repeated captures small. The Go
      // daemon sniffs the actual media type from the magic bytes before
      // attaching the image to an LLM request (provider.SniffImageMediaType),
      // so the encoding here can change without breaking the API contract.
      return image.toJPEG(quality).toString('base64')
    } catch {
      return null
    }
  }

  /** Current {url,title} of a web pane, or null if absent. */
  getInfo(paneId: string): { url: string; title: string } | null {
    const entry = this.panes.get(paneId)
    if (!entry) return null
    return { url: entry.view.webContents.getURL(), title: entry.view.webContents.getTitle() }
  }

  /**
   * Suppress (hide) or restore ALL web views while a DOM modal is up. A native
   * WebContentsView renders above all HTML, so a DOM overlay (e.g. the approval
   * dialog) is occluded by an embedded browser unless the view is hidden. Uses
   * setVisible (not off-screen bounds) so the renderer's continuous setBounds
   * re-pinning can't un-hide it; the flag is also honoured by show()/create() so
   * a pane (re)activated mid-modal stays hidden until restored.
   */
  setSuppressed(on: boolean): void {
    this.suppressed = on
    // Toggle visibility only — never touch bounds. The active pane's bounds are
    // owned by the renderer's ResizeObserver and background-tab panes are parked
    // off-screen via showOnly (whose bounds aren't reflected in entry.bounds), so
    // re-applying entry.bounds here would wrongly surface a background pane.
    for (const entry of this.panes.values()) {
      entry.view.setVisible(!on)
    }
  }

  /**
   * Hide all web panes (e.g., when switching tabs or showing a modal overlay).
   */
  hideAll(): void {
    for (const entry of this.panes.values()) {
      entry.view.setBounds({ x: -9999, y: -9999, width: 1, height: 1 })
    }
  }

  /**
   * Restore all web panes to their saved bounds.
   */
  showAll(): void {
    for (const entry of this.panes.values()) {
      entry.view.setBounds(entry.bounds)
    }
  }

  /**
   * Show only specific panes (by ID), hide all others.
   * Used when switching tabs — only panes belonging to the active tab are visible.
   */
  showOnly(paneIds: Set<string>): void {
    for (const [id, entry] of this.panes.entries()) {
      if (paneIds.has(id)) {
        entry.view.setBounds(entry.bounds)
      } else {
        entry.view.setBounds({ x: -9999, y: -9999, width: 1, height: 1 })
      }
    }
  }

  /**
   * Bring a specific web pane to the front (for stacked pane rotation).
   */
  setTopMost(paneId: string): void {
    const entry = this.panes.get(paneId)
    if (!entry) return

    // Remove and re-add to bring to front
    this.window.contentView.removeChildView(entry.view)
    this.window.contentView.addChildView(entry.view)
  }

  /**
   * Clear cookies and cache for a web pane's session.
   */
  async clearSession(paneId: string): Promise<void> {
    const entry = this.panes.get(paneId)
    if (!entry) return

    const ses = entry.view.webContents.session
    await ses.clearStorageData()
    await ses.clearCache()
    console.log(`[webPane:${paneId}] Session cleared`)
  }

  /**
   * Import cookies (extracted from a real-Chrome Google login by the CLI's
   * `##web import-google-session`) into a profile's persistent session
   * partition. Web panes on that profile then carry the Google session, so a
   * third-party "Sign in with Google" completes using the existing session
   * instead of the credential page Google blocks in embedded browsers. Targets
   * the partition by name, so it works whether or not a pane is open on it yet.
   */
  async importCookies(profile: string, cookies: ImportCookie[]): Promise<{ set: number; failed: number }> {
    const partitionName = profile && profile.trim() !== '' ? profile : 'default'
    const ses = session.fromPartition(`persist:${partitionName}`)
    // Ensure the plain-Chrome identity spoof is registered on this session even
    // if no pane has been created on it yet (idempotent).
    this.spoofChromeIdentity(ses)

    let set = 0
    let failed = 0
    await Promise.all(
      cookies.map(async (c) => {
        // Electron requires a `url`; CDP doesn't return one, so synthesize it
        // from domain (drop the host-wildcard leading dot) + path + scheme.
        const host = c.domain.replace(/^\./, '')
        const details: Electron.CookiesSetDetails = {
          url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: this.mapSameSite(c.sameSite),
        }
        // Omit expirationDate for session cookies (expires <= 0).
        if (c.expires && c.expires > 0) details.expirationDate = c.expires
        try {
          await ses.cookies.set(details)
          set++
        } catch (err) {
          failed++
          console.error(`[webPane] cookie set failed (${c.name} @ ${c.domain}):`, err)
        }
      })
    )
    console.log(`[webPane] importCookies(persist:${partitionName}): ${set} set, ${failed} failed`)
    return { set, failed }
  }

  // Map CDP's TitleCase sameSite to Electron's enum (None → no_restriction,
  // empty/unknown → unspecified).
  private mapSameSite(s: string): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
    switch ((s || '').toLowerCase()) {
      case 'strict':
        return 'strict'
      case 'lax':
        return 'lax'
      case 'none':
        return 'no_restriction'
      default:
        return 'unspecified'
    }
  }

  /**
   * Check if a web pane exists.
   */
  has(paneId: string): boolean {
    return this.panes.has(paneId)
  }

  /**
   * Get the count of active web panes.
   */
  count(): number {
    return this.panes.size
  }

  /**
   * Register navigation event handlers for status updates.
   */
  private registerEventHandlers(paneId: string, view: WebContentsView): void {
    const contents = view.webContents

    const emitStatus = (): void => {
      if (!this.statusCallback) return

      this.statusCallback({
        paneId,
        url: contents.getURL(),
        title: contents.getTitle(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        loading: contents.isLoading(),
      })
    }

    // Re-apply fit-to-pane zoom after navigation/load: Chromium tracks zoom
    // per-origin and resets it on a cross-origin load, so a freshly loaded page
    // would otherwise render at 1.0 and clip in a small pane.
    const applyZoom = (): void => this.applyFitZoom(this.panes.get(paneId))

    contents.on('did-navigate', () => { emitStatus(); applyZoom() })
    contents.on('did-navigate-in-page', emitStatus)
    contents.on('did-finish-load', applyZoom)
    contents.on('dom-ready', applyZoom)
    contents.on('page-title-updated', emitStatus)
    contents.on('did-start-loading', emitStatus)
    contents.on('did-stop-loading', emitStatus)
    contents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error(`[webPane:${paneId}] Load failed: ${errorCode} ${errorDescription}`)
      emitStatus()
    })

    // Window-open policy:
    //  • OAuth / SSO sign-in popups use window.open with a popup disposition
    //    ('new-window'/'other') and MUST open as a real child window that keeps
    //    its window.opener link and shares this pane's session. The provider
    //    page (e.g. accounts.google.com) needs the opener to postMessage the
    //    credential back and then window.close() itself. Denying these and
    //    loading in-place — the previous behavior — destroyed the opener and
    //    stranded the user on a blank accounts.google.com/gsi/transform relay.
    //    No webPreferences override here: the popup then inherits the opener's
    //    session/sandbox, which is what preserves the opener + shared login.
    //  • Plain in-page links (target="_blank", disposition 'foreground-tab'/
    //    'background-tab') stay inside the pane so we don't spawn stray windows.
    contents.setWindowOpenHandler((details) => {
      const { url, disposition } = details
      if (disposition === 'new-window' || disposition === 'other') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 480,
            height: 700,
            autoHideMenuBar: true,
            parent: this.window,
            // Create HIDDEN so it never auto-activates the app on show. A
            // visible new BrowserWindow raises its app to the foreground on
            // macOS; for a BACKGROUND instance running web automation, a
            // popup its page opens (or an AI-driven navigation) would yank
            // that instance — and the whole app — over whatever the user is
            // actually working in. presentChildWindow() shows it inactively
            // unless this instance's window is the one the user has focused.
            show: false,
          },
        }
      }
      contents.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })

    // Apply the same policy to any child window the popup itself opens (some
    // providers chain through a second window), and re-emit status when the
    // popup completes so the pane reflects any post-login navigation.
    contents.on('did-create-window', (child) => {
      // The popup is a separate webContents (shares the session, so its headers
      // are already spoofed) — give it the same CDP identity override so its
      // navigator.userAgentData isn't "Electron" during the sign-in handshake.
      this.applyIdentityOverride(child.webContents).catch(() => {})
      this.presentChildWindow(child)
      child.webContents.setWindowOpenHandler((d) => {
        if (d.disposition === 'new-window' || d.disposition === 'other') {
          return {
            action: 'allow',
            overrideBrowserWindowOptions: { autoHideMenuBar: true, parent: this.window, show: false },
          }
        }
        child.webContents.loadURL(d.url).catch(() => {})
        return { action: 'deny' }
      })
      child.webContents.on('did-create-window', (grandchild) => this.presentChildWindow(grandchild))
      child.on('closed', emitStatus)
    })
  }

  /**
   * Show a web-pane child window (OAuth popup, provider chain window) WITHOUT
   * stealing focus unless this instance is the one the user is actively using.
   * Popups are created hidden (show:false); here we decide how to reveal them:
   *
   *   - This instance's main window is focused (user just clicked "Sign in" and
   *     is watching): show() normally so the interactive login is front-and-key.
   *   - Otherwise (this is a BACKGROUND instance — the reported bug: a
   *     background app running web automation whose Chrome pane updates/opens a
   *     window): showInactive(), so the popup appears in place but does NOT
   *     raise this instance or the app over the user's current window.
   */
  private presentChildWindow(child: BrowserWindow): void {
    if (!child || child.isDestroyed()) return
    const ownerFocused = !!this.window && !this.window.isDestroyed() && this.window.isFocused()
    if (ownerFocused) {
      child.show()
    } else {
      child.showInactive()
    }
  }
}
