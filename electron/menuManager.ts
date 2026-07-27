import { app, Menu, BrowserWindow, Tray, nativeImage, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { WorkspaceInfo } from './workspaceManager'

export interface MenuManagerOptions {
  onOpenWorkspace?: () => void
  onSelectWorkspace?: (path: string) => void
  /** Launch a brand-new, fully-isolated app instance (own profile/port/session). */
  onNewInstance?: () => void
  /** Bring the next/previous running instance's window to the foreground (⌘`/Ctrl+`). */
  onCycleInstance?: (direction: 'next' | 'prev') => void
  /** Reload only the app UI (renderer); the daemon keeps running. */
  onReloadApp?: () => void
  /** Restart the daemon (new binary) and reload the renderer. */
  onRestartDaemon?: () => void
  /** Detach: leave the daemon running and quit the app (state preserved). */
  onDetachSession?: () => void
  recentWorkspaces?: WorkspaceInfo[]
  /** Whether a workspace is currently open (gates "Close Workspace"). */
  hasWorkspace?: boolean
}

/**
 * NativeMenuManager sets up the application menu, system tray,
 * and context menus for the Rysh desktop app.
 */
export class NativeMenuManager {
  private window: BrowserWindow
  private tray: Tray | null = null
  private options: MenuManagerOptions

  constructor(window: BrowserWindow, options?: MenuManagerOptions) {
    this.window = window
    this.options = options || {}
  }

  /**
   * Set up the application menu and system tray.
   */
  setup(): void {
    this.setupAppMenu()
    this.setupTray()
  }

  /**
   * Rebuild the application menu (e.g. after recent workspaces change).
   */
  refreshMenu(options?: MenuManagerOptions): void {
    if (options) {
      this.options = { ...this.options, ...options }
    }
    this.setupAppMenu()
  }

  /**
   * Build and apply the application menu bar.
   */
  private setupAppMenu(): void {
    const isMac = process.platform === 'darwin'
    const recentWorkspaces = this.options.recentWorkspaces || []

    // Build recent workspaces submenu items
    const recentItems: Electron.MenuItemConstructorOptions[] =
      recentWorkspaces.length > 0
        ? recentWorkspaces.map((ws) => ({
            label: `${ws.name}  -  ${ws.path}`,
            click: (): void => {
              this.options.onSelectWorkspace?.(ws.path)
            },
          }))
        : [{ label: 'No Recent Workspaces', enabled: false }]

    const template: Electron.MenuItemConstructorOptions[] = [
      // App menu (macOS only)
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                { role: 'services' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
              ],
            },
          ]
        : []),
      // File
      {
        label: 'File',
        submenu: [
          {
            // Spawn another fully-isolated instance (own window, profile, NATS
            // port and session namespace). Distinct from the OS "new window",
            // which would share this instance's daemon.
            label: 'New Instance',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: (): void => {
              this.options.onNewInstance?.()
            },
          },
          { type: 'separator' },
          {
            label: 'Open Workspace...',
            accelerator: 'CmdOrCtrl+O',
            click: (): void => {
              this.options.onOpenWorkspace?.()
            },
          },
          { type: 'separator' },
          {
            label: 'Recent Workspaces',
            submenu: recentItems,
          },
          { type: 'separator' },
          {
            label: 'Close Workspace',
            // Disabled when no workspace is open — there is nothing to close.
            enabled: this.options.hasWorkspace ?? false,
            click: (): void => {
              // Selecting with empty path signals "close workspace"
              this.options.onSelectWorkspace?.('')
            },
          },
          { type: 'separator' },
          {
            // Leave the daemon running and quit — reattach later (with full
            // in-memory state) by reopening the same workspace + session.
            // Distinct from Quit, which stops the daemon.
            label: 'Detach Session',
            accelerator: 'CmdOrCtrl+D',
            click: (): void => {
              this.options.onDetachSession?.()
            },
          },
        ],
      },
      // Edit
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      // View
      {
        label: 'View',
        submenu: [
          // Reload only the app UI (renderer); the daemon and all its state
          // (NATS, panes, running shells) keep running on the same port.
          {
            label: 'Reload App',
            accelerator: 'CmdOrCtrl+Alt+R',
            click: (): void => {
              this.options.onReloadApp?.()
            },
          },
          // Restart the Go daemon against the binary on disk (swaps in a freshly
          // built sidecar) and reload the app. Restarts the backend, so running
          // shells are lost; persisted layout + pane content are restored.
          {
            label: 'Restart Daemon (New Binary)',
            accelerator: 'CmdOrCtrl+Shift+Alt+R',
            click: (): void => {
              this.options.onRestartDaemon?.()
            },
          },
          { type: 'separator' },
          // Reload moved off Cmd/Ctrl+R (to F5) so Ctrl+R is free for the
          // voice-prompting hotkey. Force-reload (Cmd/Ctrl+Shift+R) still works.
          { role: 'reload', accelerator: 'F5' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      // Window
      {
        label: 'Window',
        submenu: [
          // Cross-instance switching. The actual ⌘`/Ctrl+` keys (and their ⇧
          // variants) are handled in main via before-input-event (⌘` is a macOS
          // system shortcut, awkward as a menu accelerator), so these carry no
          // accelerator — the hint is shown in the label and clicking still works.
          {
            label: 'Next Instance (⌘` / ^` / ^\\)',
            click: (): void => {
              this.options.onCycleInstance?.('next')
            },
          },
          {
            label: 'Previous Instance (⌘⇧` / ^⇧` / ^⇧\\)',
            click: (): void => {
              this.options.onCycleInstance?.('prev')
            },
          },
          { type: 'separator' },
          { role: 'minimize' },
          { role: 'zoom' },
          ...(isMac
            ? [
                { type: 'separator' as const },
                { role: 'front' as const },
                { type: 'separator' as const },
                { role: 'window' as const },
              ]
            : [{ role: 'close' as const }]),
        ],
      },
      // Help
      {
        label: 'Help',
        submenu: [
          {
            label: 'Documentation',
            click: (): void => {
              shell.openExternal('https://github.com/rysh-ai/rysh-cli-parent#readme')
            },
          },
          {
            label: 'Report Issue',
            click: (): void => {
              shell.openExternal('https://github.com/rysh-ai/rysh-cli-app-code/issues')
            },
          },
          { type: 'separator' },
          {
            label: 'About Rysh',
            click: (): void => {
              const { dialog } = require('electron')
              dialog.showMessageBox(this.window, {
                type: 'info',
                title: 'About Rysh',
                message: `Rysh Desktop v${app.getVersion()}`,
                detail: 'Agentic terminal multiplexer with embedded web panes.',
              })
            },
          },
        ],
      },
    ]

    const menu = Menu.buildFromTemplate(template)
    Menu.setApplicationMenu(menu)
  }

  /**
   * Set up the system tray icon and context menu.
   */
  private setupTray(): void {
    // Create tray icon
    const iconPath = is.dev
      ? join(app.getAppPath(), 'resources', 'tray-icon.png')
      : join(process.resourcesPath, 'tray-icon.png')

    // Use a fallback 16x16 empty image if the icon file doesn't exist
    let trayIcon: Electron.NativeImage
    try {
      trayIcon = nativeImage.createFromPath(iconPath)
      if (trayIcon.isEmpty()) {
        trayIcon = nativeImage.createEmpty()
      }
    } catch {
      trayIcon = nativeImage.createEmpty()
    }

    // Resize for tray (16x16 on most platforms)
    if (!trayIcon.isEmpty()) {
      trayIcon = trayIcon.resize({ width: 16, height: 16 })
    }

    this.tray = new Tray(trayIcon)
    this.tray.setToolTip('Rysh Desktop')

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show/Hide Rysh',
        click: (): void => {
          if (this.window.isVisible()) {
            this.window.hide()
          } else {
            // showInactive, not show: win.show() on a hidden window poisons
            // macOS activation (web-pane navigations then steal focus from
            // other apps — see main.ts ready-to-show). The tray click is a
            // deliberate user activation, so steal focus explicitly.
            this.window.showInactive()
            this.window.focus()
            app.focus({ steal: true })
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: (): void => {
          app.quit()
        },
      },
    ])

    this.tray.setContextMenu(contextMenu)

    // Click on tray icon toggles window visibility
    this.tray.on('click', () => {
      if (this.window.isVisible()) {
        this.window.hide()
      } else {
        // showInactive + explicit app focus — same rationale as the menu item.
        this.window.showInactive()
        this.window.focus()
        app.focus({ steal: true })
      }
    })
  }

  /**
   * Clean up the tray.
   */
  destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }
}
