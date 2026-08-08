import { app, BrowserWindow, dialog, shell, session } from 'electron'
import { join, basename } from 'path'
import { is } from '@electron-toolkit/utils'
import { SidecarManager } from './sidecar'
import { WebPaneManager } from './webPaneManager'
import { registerIpcHandlers } from './ipc'
import { NativeMenuManager } from './menuManager'
import { WindowStateManager } from './windowState'
import { AutoUpdateManager } from './autoUpdate'
import { WorkspaceManager } from './workspaceManager'
import { pickSession, promptForSessionName } from './sessionPicker'
import { findSession, listSessions } from './sessionStore'
import {
  allocateInstance,
  releaseInstance,
  spawnNewInstance,
  focusSiblingInstance,
} from './instanceManager'

let mainWindow: BrowserWindow | null = null

// Cross-instance window switching (⌘` / Ctrl+`): a sibling instance asks us to come to
// the foreground by sending SIGUSR2. We handle it by raising our own window —
// app.focus({steal:true}) makes us the active app without needing any
// Accessibility/Automation permission. Registered BEFORE allocateInstance
// publishes our pid (presence file) so a sibling can't deliver SIGUSR2 — whose
// POSIX default action is to terminate the process — before we're listening.
process.on('SIGUSR2', () => {
  const win = mainWindow
  if (win) {
    if (win.isMinimized()) win.restore()
    // showInactive, not show: win.show() on a hidden window poisons macOS
    // activation (web-pane navigations then steal focus from other apps —
    // see the ready-to-show comment). app.focus({steal:true}) below provides
    // the actual app activation this handler needs.
    if (!win.isVisible()) win.showInactive()
    win.focus()
  }
  if (app.isReady()) app.focus({ steal: true })
})

// Decide which instance this process is BEFORE anything touches userData. For a
// secondary instance this switches to a per-slot Electron profile, so all the
// managers below (window state, recents, daemon registry) land in the right
// place. The primary (slot 0) is unchanged from the legacy single-instance app.
const instance = allocateInstance()

let sidecarManager: SidecarManager | null = null
let webPaneManager: WebPaneManager | null = null
let menuManager: NativeMenuManager | null = null
let windowStateManager: WindowStateManager | null = null
let autoUpdateManager: AutoUpdateManager | null = null
let workspaceManager: WorkspaceManager | null = null
// Guards restartDaemon() so a double-click / repeated shortcut can't overlap two
// stop→start cycles on the same session (which would race two daemons on one
// NATS server — the exact failure killStaleSidecars exists to prevent).
let restartingDaemon = false

function createWindow(): BrowserWindow {
  // Restore previous window bounds if available
  const savedBounds = windowStateManager?.getBounds()

  const win = new BrowserWindow({
    width: savedBounds?.width ?? 1400,
    height: savedBounds?.height ?? 900,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#1e1e1e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 8 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })

  // Restore maximized state
  if (savedBounds?.isMaximized) {
    win.maximize()
  }

  // On secondary instances, brand the title so multiple windows are
  // distinguishable. The renderer sets document.title, so re-assert ours
  // whenever it does (preventDefault stops the renderer's title from winning).
  if (instance.label) {
    const instanceTitle = `Rysh — ${instance.label}`
    win.setTitle(instanceTitle)
    win.on('page-title-updated', (e) => {
      e.preventDefault()
      win.setTitle(instanceTitle)
    })
  }

  // ⌘`/Ctrl+` (and the equivalent ⌘\/Ctrl+\) cycle focus to the NEXT instance,
  // the ⇧ variants to the PREVIOUS — mirroring macOS's own ⌘`-cycles-windows,
  // but across our separate-process instances (which the OS shortcut can't
  // reach). Ctrl+` / Ctrl+\ are the cross-platform bindings (and work on
  // Linux/Windows where ⌘ doesn't exist). Captured here rather than via a menu
  // accelerator because ⌘` is a system shortcut and matching on `code` is layout-
  // and shift-independent (Shift+` emits '~', Shift+\ emits '|'). preventDefault
  // overrides the OS's in-app window cycle (a no-op anyway with one window per
  // instance) and keeps these chords out of the embedded terminal (where they
  // would otherwise send NUL / SIGQUIT (FS) to the PTY).
  win.webContents.on('before-input-event', (event, input) => {
    const exactlyOneMod = (input.meta || input.control) && !(input.meta && input.control)
    if (
      input.type === 'keyDown' &&
      exactlyOneMod &&
      !input.alt &&
      (input.code === 'Backquote' || input.code === 'Backslash')
    ) {
      event.preventDefault()
      focusSiblingInstance(input.shift ? 'prev' : 'next')
    }
  })

  // Track window state changes for persistence
  windowStateManager?.track(win)

  win.on('ready-to-show', () => {
    // NEVER win.show() on a window created hidden (show:false): on macOS that
    // poisons the window's activation state so that EVERY subsequent
    // WebContentsView navigation re-activates the app from the background —
    // any page change in an embedded web pane yanked Rysh above whatever app
    // the user was working in (repro'd on Electron 31 and 41; webPreferences
    // focusOnNavigation:false does NOT cover this path). showInactive()
    // orders the window front without the poisoned path; focus() then makes
    // it key — on a normal launch macOS has already activated the app, so
    // startup behavior is unchanged.
    win.showInactive()
    win.focus()
  })

  // Open external links in the default browser
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

/**
 * Connect to a session's daemon, preferring to ADOPT a live one over spawning a
 * new one, and cold-starting only when there is nothing to adopt. Returns true
 * if a running daemon was adopted.
 *
 * Adoption matters because it preserves the daemon's full in-memory state —
 * running shells, scrollback, agent state — where a cold start restores only
 * what KV persisted (layout and pane content; live shells are gone).
 *
 * Two ways in, tried in order:
 *
 *  1. The app's private registry, which holds {pid, webPort} for daemons THIS
 *     app spawned and later detached from.
 *  2. The session record on disk, which every daemon maintains regardless of
 *     which front-end started it. This is what makes a command-line session
 *     openable here at all: the app never spawned it, so the registry has
 *     never heard of it, and its daemon may have no web server for the
 *     renderer to reach — ensureWebEndpoint discovers or opens one.
 *
 * Cold-starting is the fallback, but only when there is genuinely no live
 * daemon. A daemon that is ALIVE yet unreachable throws instead: spawning a
 * second daemon for the same session name would put two of them on the same
 * ws.* subjects, which is a worse outcome than a visible failure.
 */
async function adoptOrStart(
  sidecar: SidecarManager,
  sessionName: string,
  dirPath: string
): Promise<boolean> {
  const known = sidecar.getRegistry().findAlive(dirPath, sessionName)
  if (known && (await sidecar.adopt(sessionName, dirPath, known.webPort, known.pid))) {
    return true
  }

  const found = await sidecar.ensureWebEndpoint(sessionName, dirPath)
  if (found.kind === 'endpoint') {
    if (await sidecar.adopt(sessionName, dirPath, found.port, found.pid)) {
      return true
    }
    throw new Error(
      `session "${sessionName}" has a live daemon (pid ${found.pid}) whose web server ` +
        `stopped answering — refusing to start a second daemon for it`
    )
  }
  if (found.kind === 'unreachable') {
    throw new Error(
      `session "${sessionName}" has a live daemon (pid ${found.pid}) this app cannot reach: ` +
        `${found.reason}. Open a web server in it (##rysh web start) or stop it first — ` +
        `starting a second daemon for the same session would collide with the first.`
    )
  }

  sidecar.setWorkingDirectory(dirPath)
  sidecar.setSessionName(sessionName)
  await sidecar.start()
  return false
}

/**
 * Open a workspace by directory path. Validates rysh.config exists,
 * restarts the sidecar with the workspace as CWD, and notifies the renderer.
 */
async function openWorkspace(
  dirPath: string,
  sessionName?: string
): Promise<{ success: boolean; error?: string }> {
  if (!workspaceManager || !sidecarManager || !webPaneManager || !mainWindow) {
    return { success: false, error: 'App not fully initialized' }
  }

  // Validate the directory has a rysh config (rysh.config.yaml).
  if (!workspaceManager.validateWorkspace(dirPath)) {
    return { success: false, error: `No rysh.config.yaml found in ${dirPath}` }
  }

  // `name` is the workspace's display name (folder); `session` is the rysh
  // session to launch — the one the user picked, or the folder name as a
  // fallback when none was chosen.
  const name = basename(dirPath)
  const session = sessionName?.trim() || name
  console.log(`[main] Opening workspace: ${name} (${dirPath}) session=${session}`)

  // Already showing this exact session and it's healthy — nothing to do but
  // make sure the renderer is pointed at it. Avoids stopping (killing) the very
  // daemon we'd want to keep.
  const onThisSession =
    sidecarManager.getWorkingDirectory() === dirPath &&
    sidecarManager.getSessionName() === session &&
    sidecarManager.isRunning()
  if (onThisSession) {
    workspaceManager.setCurrent(dirPath)
    workspaceManager.addRecent(dirPath, session)
    refreshMenus()
    mainWindow.webContents.send('workspace-changed', {
      path: dirPath,
      name,
      port: sidecarManager.getPort(),
    })
    return { success: true }
  }

  try {
    // Stop the current (app-owned) sidecar — we're navigating away from it. A
    // deliberately-detached daemon would have been left via detachSession(),
    // not via this path, so stopping here is correct.
    await sidecarManager.stop()

    // Destroy all web panes
    webPaneManager.destroyAll()

    const adopted = await adoptOrStart(sidecarManager, session, dirPath)
    console.log(
      `[main] ${adopted ? 'Adopted running' : 'Cold-started'} daemon on port ` +
        `${sidecarManager.getPort()} for session ${session}`
    )

    // Update workspace manager state (also records the session so the next
    // launch reopens this exact workspace+session by default).
    workspaceManager.setCurrent(dirPath)
    workspaceManager.addRecent(dirPath, session)

    // Refresh menus to update recent workspaces list
    refreshMenus()

    // Notify the renderer about the workspace change and new port
    mainWindow.webContents.send('workspace-changed', {
      path: dirPath,
      name,
      port: sidecarManager.getPort(),
    })

    return { success: true }
  } catch (err) {
    console.error('[main] Failed to open workspace:', err)
    return { success: false, error: `Failed to start sidecar: ${err}` }
  }
}

/**
 * Resolve which session to open for a workspace ROOT, then open it. Lists the
 * app's sessions for the workspace and asks the user to pick one or create a new
 * (named) session. Cancelling at any step is a no-op. Used by both the
 * Open-Workspace dialog and Recent-Workspace selection.
 */
async function openWorkspaceWithPicker(
  root: string
): Promise<{ success: boolean; error?: string }> {
  if (!mainWindow) return { success: false, error: 'App not fully initialized' }

  const choice = await pickSession(mainWindow, root)
  if (choice.kind === 'cancel') {
    return { success: true } // user backed out — leave the current workspace as-is
  }

  let sessionName: string
  if (choice.kind === 'existing') {
    sessionName = choice.name
  } else {
    // New session — prompt for a name (defaulting to the workspace folder).
    const proposed = await promptForSessionName(mainWindow, basename(root))
    if (!proposed) {
      return { success: true } // cancelled the name prompt
    }
    // Refuse a name already owned by a command-line session: the app cannot open
    // CLI sessions, and reusing the name would only trip the daemon's guard.
    const existing = findSession(root, proposed)
    if (existing && existing.source !== 'app') {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Name In Use',
        message: `A command-line session named "${proposed}" already exists`,
        detail:
          'Sessions created by the rysh command line cannot be opened from the ' +
          'desktop app. Please choose a different name.',
      })
      return { success: false, error: 'session name belongs to a command-line session' }
    }
    sessionName = proposed
  }

  return openWorkspace(root, sessionName)
}

/**
 * Close the currently open workspace. Stops the daemon, tears down its web
 * panes, then restarts a fresh `default` session anchored at the user's home
 * directory. Stops the daemon, tears down its web panes, and returns the app to
 * the empty (welcome) screen — the state a fresh instance boots into. Also
 * FORGETS the launch-default workspace: an explicit close means the next launch
 * starts empty instead of reopening this project. A no-op when no workspace is
 * open.
 *
 * Backs the File ▸ "Close Workspace" menu item (signalled by an empty path).
 */
async function closeWorkspace(): Promise<{ success: boolean; error?: string }> {
  if (!workspaceManager || !sidecarManager || !webPaneManager || !mainWindow) {
    return { success: false, error: 'App not fully initialized' }
  }

  // Nothing to close — already on the empty screen.
  if (!workspaceManager.getCurrent()) {
    return { success: true }
  }

  console.log('[main] Closing workspace; returning to the empty screen (no daemon)')

  try {
    // Stop the running daemon and drop its web panes (mirrors openWorkspace).
    await sidecarManager.stop()
    webPaneManager.destroyAll()

    // Reset the sidecar's target so a later open starts from a clean slate.
    sidecarManager.clearWorkingDirectory()
    sidecarManager.setSessionName(instance.bootSession)

    // Clear current-workspace state, forget the launch default, refresh menus.
    workspaceManager.clearCurrent()
    workspaceManager.clearLast()
    refreshMenus()

    // Notify the renderer: empty path/name + port 0 signals "no workspace
    // open, no daemon" — it disconnects and shows the welcome screen.
    mainWindow.webContents.send('workspace-changed', { path: '', name: '', port: 0 })

    return { success: true }
  } catch (err) {
    console.error('[main] Failed to close workspace:', err)
    return { success: false, error: `Failed to close workspace: ${err}` }
  }
}

/**
 * Show an open dialog (file or directory) and open the selected workspace.
 * The user may pick a rysh.config.yaml file directly, or a directory containing
 * one (beside a .rysh dir, or inside its .rysh dir). The selection is resolved to
 * the workspace ROOT, which becomes the daemon's cwd.
 */
async function showOpenWorkspaceDialog(): Promise<void> {
  if (!mainWindow || !workspaceManager) return

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Rysh Workspace',
    message: 'Choose a rysh.config.yaml file, or a directory that contains one',
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'Rysh config', extensions: ['yaml', 'yml'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })

  if (result.canceled || result.filePaths.length === 0) return

  const selected = result.filePaths[0]

  // Resolve the selection (file or directory) to the workspace root.
  const root = workspaceManager.resolveWorkspaceRoot(selected)
  if (!root) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Invalid Workspace',
      message: 'Not a rysh workspace',
      detail:
        `The selection is not a rysh workspace:\n${selected}\n\n` +
        `Select a rysh.config.yaml file, or a directory that contains either ` +
        `rysh.config.yaml or .rysh/rysh.config.yaml.`,
    })
    return
  }

  await openWorkspaceWithPicker(root)
}

/**
 * Refresh the application menus with current workspace state.
 */
function refreshMenus(): void {
  if (!menuManager || !workspaceManager) return
  menuManager.refreshMenu({
    recentWorkspaces: workspaceManager.getRecent(),
    hasWorkspace: !!workspaceManager.getCurrent(),
  })
}

/**
 * Reload ONLY the app UI (renderer), leaving the daemon and all of its state
 * (embedded NATS, actors, panes, running shells) untouched. The renderer
 * reconnects to the same daemon on the same port. Use after changing renderer
 * code; for a freshly rebuilt Go daemon use restartDaemon() instead.
 *
 * Backs the View ▸ "Reload App" menu item and the Header ⟳ button.
 */
function reloadApp(): void {
  if (!mainWindow) return
  console.log('[main] Reloading app UI (daemon kept running)')
  // reloadIgnoringCache so a rebuilt renderer bundle isn't served stale.
  mainWindow.webContents.reloadIgnoringCache()
}

/**
 * Restart the daemon against the binary currently on disk, then reload the app.
 *
 * The sidecar is a spawned external process, so a freshly rebuilt
 * `sidecar/rysh-*` binary is NOT picked up until the daemon is restarted
 * (`make build-sidecar-local` rebuilds the binary; this swaps it in). We stop
 * the running daemon, tear down its web panes, then start a new daemon for the
 * SAME session and working directory — SidecarManager keeps both across
 * stop/start, so the workspace state is restored from KV onto a new port.
 * Finally we reload the renderer so it re-fetches the new port (getPort) and
 * loads the latest renderer build.
 *
 * Unlike reloadApp(), this DOES restart the daemon (losing running shells /
 * in-memory PTY state; persisted layout + pane content are restored from KV).
 *
 * Backs the View ▸ "Restart Daemon" menu item and the Header ⏻ button.
 */
async function restartDaemon(): Promise<{ success: boolean; error?: string }> {
  if (!sidecarManager || !webPaneManager || !mainWindow) {
    return { success: false, error: 'App not fully initialized' }
  }
  if (restartingDaemon) {
    return { success: false, error: 'A daemon restart is already in progress' }
  }
  restartingDaemon = true

  const session = sidecarManager.getSessionName()
  console.log(`[main] Restarting daemon for session "${session}" against the on-disk binary`)

  try {
    // Stop the running daemon and drop its web panes (mirrors openWorkspace).
    await sidecarManager.stop()
    webPaneManager.destroyAll()

    // Re-spawn the daemon. start() re-resolves the binary path, so a rebuilt
    // sidecar/rysh-* is loaded; the preserved session name + cwd restore the
    // same workspace from KV.
    await sidecarManager.start()
    console.log(`[main] Daemon restarted on port ${sidecarManager.getPort()} for session ${session}`)

    // Reload the renderer so it reconnects to the new port and loads the latest
    // renderer build. reloadIgnoringCache so a rebuilt bundle isn't served stale.
    mainWindow.webContents.reloadIgnoringCache()

    return { success: true }
  } catch (err) {
    console.error('[main] Failed to restart daemon:', err)
    return { success: false, error: `Failed to restart daemon: ${err}` }
  } finally {
    restartingDaemon = false
  }
}

/**
 * Detach the current session: leave the daemon running (preserving its full
 * in-memory state) and KEEP THE APP OPEN, showing an empty "no active session"
 * state. The daemon's {pid, webPort} stays in the registry, so it can be
 * re-adopted later by opening the same workspace + session in the picker.
 *
 * Distinct from Quit (Cmd+Q), which stops the daemon, and from Close Workspace,
 * which reverts to a fresh default session. Backs the File ▸ "Detach Session"
 * menu item and the Header ⏏ button.
 */
function detachSession(): { success: boolean; error?: string } {
  if (!sidecarManager || !webPaneManager || !workspaceManager || !mainWindow) {
    return { success: false, error: 'App not fully initialized' }
  }
  const session = sidecarManager.getSessionName()
  const pid = sidecarManager.detach() // leaves the daemon running, drops our handle
  if (pid <= 0) {
    return { success: false, error: 'No running session to detach' }
  }
  console.log(
    `[main] Detached session "${session}" (daemon pid=${pid} left running); keeping the app open (empty state)`
  )

  // Tear down this session's web panes and clear current-workspace state, but do
  // NOT quit. The daemon stays running so it can be re-adopted later.
  webPaneManager.destroyAll()
  workspaceManager.clearCurrent()
  refreshMenus()

  // Tell the renderer there is no active session: an empty path/name + port 0
  // makes it disconnect from the (now detached) daemon and show the empty state
  // without reconnecting to it.
  mainWindow.webContents.send('workspace-changed', { path: '', name: '', port: 0 })
  return { success: true }
}

// Free this process's instance-slot lock on the way out so the slot can be
// reused. will-quit covers Quit and Detach; the exit hook is a backstop for hard
// teardowns that skip it.
app.on('will-quit', releaseInstance)
process.on('exit', releaseInstance)

// There is deliberately NO single-instance lock: every plain launch allocates
// its own instance slot (allocateInstance) with its own profile, NATS port and
// session namespace, so any number of rysh apps coexist side by side. Slot
// exclusivity is enforced by the per-slot lockfiles instead.

app.whenReady().then(async () => {
  // Present a clean Chrome user-agent to web panes. Electron's default UA
  // carries "Electron/<v>" and "rysh-cli-app/<v>" tokens, which Google (and
  // some other SSO providers) treat as a "disallowed user agent" and refuse to
  // complete OAuth in — e.g. "Sign in with Google" on claude.ai. Stripping the
  // app/Electron tokens (keeping the real Chrome/<v> token) makes the embedded
  // browser look like plain Chrome so sign-in flows succeed. Set before any
  // web-pane webContents (or its popups) is created so all inherit it.
  app.userAgentFallback =
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`

  // Initialize managers
  windowStateManager = new WindowStateManager()
  sidecarManager = new SidecarManager(instance.id)
  // Anchor this instance's daemons to its own session namespace and (for
  // secondaries) its own embedded-NATS port + JetStream store, set BEFORE the
  // boot adoption below reads getSessionName().
  sidecarManager.setSessionName(instance.bootSession)
  sidecarManager.setNatsPort(instance.natsPort)
  sidecarManager.setNatsDataDir(instance.natsDataDir)
  workspaceManager = new WorkspaceManager()

  // Grant microphone (getUserMedia) access to our own renderer for voice
  // prompting, but only to the main window — not to web-pane BrowserViews that
  // load arbitrary external sites. Other permission requests keep the prior
  // (permissive) default so web-pane browsing is unaffected.
  const allowMediaForMain = (
    wc: Electron.WebContents | undefined,
    permission: string
  ): boolean => {
    if (permission === 'media') return !!mainWindow && wc === mainWindow.webContents
    return true
  }
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowMediaForMain(wc, permission))
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    allowMediaForMain(wc ?? undefined, permission)
  )

  // Boot policy: a fresh instance starts with NO daemon and an empty (welcome)
  // screen — nothing runs until the user opens a workspace. If THIS instance's
  // profile previously had a workspace open (and it wasn't explicitly closed),
  // reopen it now — same workspace, same session — adopting a daemon a Detach
  // left running when one is alive. The renderer pulls the resulting state
  // (workspace.getCurrent + getPort) when it loads, so no notify is needed here.
  const lastWs = workspaceManager.getLast()
  if (lastWs && workspaceManager.validateWorkspace(lastWs.path)) {
    try {
      // Session preference: the one recorded with the workspace; else the
      // workspace's most-recently-used app session (legacy entries predate the
      // recording — don't cold-start a brand-new session next to the user's
      // real one); else the folder name for a first-ever open.
      let session = lastWs.lastSession?.trim() || ''
      if (!session) {
        // Any session in the workspace, whichever front-end created it — the
        // app opens command-line sessions too. Still prefer an existing one
        // over inventing a new name: cold-starting "myproject" next to the
        // user's real session is the outcome to avoid.
        session = listSessions(lastWs.path)[0]?.name || basename(lastWs.path)
      }
      const adopted = await adoptOrStart(sidecarManager, session, lastWs.path)
      workspaceManager.setCurrent(lastWs.path)
      workspaceManager.addRecent(lastWs.path, session)
      console.log(
        `[main] Reopened last workspace ${lastWs.path} (session "${session}") — ` +
          `${adopted ? 'adopted daemon' : 'cold-started'} on port ${sidecarManager.getPort()}`
      )
    } catch (err) {
      console.error('[main] Failed to reopen the last workspace:', err)
      // Fall through to the empty screen; the user can open it manually.
    }
  } else {
    console.log('[main] No previous workspace — starting on the empty screen (no daemon)')
  }

  // Create the main window
  mainWindow = createWindow()

  // Initialize web pane manager (needs the main window)
  webPaneManager = new WebPaneManager(mainWindow)

  // Register IPC handlers (including workspace handlers)
  registerIpcHandlers(sidecarManager, webPaneManager, workspaceManager, {
    onOpenWorkspace: () => showOpenWorkspaceDialog(),
    onSelectWorkspace: async (path: string) => {
      // An empty path is the "Close Workspace" signal.
      if (!path) return closeWorkspace()
      return openWorkspaceWithPicker(path)
    },
    onReloadApp: () => reloadApp(),
    onRestartDaemon: () => restartDaemon(),
    onDetachSession: () => detachSession(),
  })

  // Set up native menus with workspace support
  menuManager = new NativeMenuManager(mainWindow, {
    onNewInstance: () => spawnNewInstance(),
    onCycleInstance: (direction) => focusSiblingInstance(direction),
    onOpenWorkspace: () => showOpenWorkspaceDialog(),
    onSelectWorkspace: (path: string) => {
      // An empty path is the "Close Workspace" signal.
      if (!path) {
        void closeWorkspace()
        return
      }
      openWorkspaceWithPicker(path)
    },
    onReloadApp: () => reloadApp(),
    onRestartDaemon: () => {
      void restartDaemon()
    },
    onDetachSession: () => {
      detachSession()
    },
    recentWorkspaces: workspaceManager.getRecent(),
    hasWorkspace: !!workspaceManager.getCurrent(),
  })
  menuManager.setup()

  // Set up auto-updater (production only)
  if (!is.dev) {
    autoUpdateManager = new AutoUpdateManager(mainWindow)
    autoUpdateManager.checkForUpdates()
  }

  // macOS: re-create window when dock icon is clicked and no windows are open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      if (webPaneManager) {
        webPaneManager.setWindow(mainWindow)
      }
    }
  })
})

app.on('before-quit', async () => {
  // Persist window state
  windowStateManager?.save()

  // Stop all web panes (UI-side BrowserViews; recreated from the snapshot on
  // reattach). Safe to drop on both Detach and Quit.
  webPaneManager?.destroyAll()

  // Normal Quit — stop the daemon (and drop its registry record via stop()).
  // A previously-detached daemon was already let go of (sidecarManager.detach()
  // cleared our handle), so stop() is a no-op for it and it keeps running.
  if (sidecarManager) {
    try {
      await sidecarManager.stop()
      console.log('[main] Sidecar stopped')
    } catch (err) {
      console.error('[main] Error stopping sidecar:', err)
    }
  }
})

app.on('window-all-closed', () => {
  // On macOS, keep the app in the dock unless explicitly quit
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
