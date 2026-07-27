import { ipcMain } from 'electron'
import type { SidecarManager } from './sidecar'
import type { WebPaneManager, WebPaneBounds, ImportCookie } from './webPaneManager'
import type { WorkspaceManager } from './workspaceManager'
import { readVoiceConfig, publicVoiceConfig, transcribeAudio } from './voice'
import { getCompletions } from './completion'
import { executeBrowserAction } from './webPaneExecutor'

export interface WorkspaceCallbacks {
  onOpenWorkspace: () => void
  onSelectWorkspace: (path: string) => Promise<{ success: boolean; error?: string }>
  /** Reload only the app UI (renderer); the daemon keeps running. */
  onReloadApp: () => void
  /** Restart the daemon (picking up a freshly built binary) and reload the app. */
  onRestartDaemon: () => Promise<{ success: boolean; error?: string }>
  /** Detach: leave the daemon running and quit the app (state preserved). */
  onDetachSession: () => { success: boolean; error?: string }
}

/**
 * Register all IPC handlers for communication between the renderer and main process.
 */
export function registerIpcHandlers(
  sidecar: SidecarManager,
  webPaneManager: WebPaneManager,
  workspaceManager?: WorkspaceManager,
  workspaceCallbacks?: WorkspaceCallbacks
): void {
  // ── Sidecar / App Info ──

  ipcMain.handle('get-sidecar-port', () => {
    return sidecar.getPort()
  })

  ipcMain.handle('get-platform', () => {
    return process.platform
  })

  ipcMain.handle('get-session-name', () => {
    return sidecar.getSessionName()
  })

  ipcMain.handle('get-sidecar-status', () => {
    return {
      running: sidecar.isRunning(),
      port: sidecar.getPort(),
      sessionName: sidecar.getSessionName(),
    }
  })

  // ── Workspace Management ──

  ipcMain.handle('get-workspace', () => {
    if (!workspaceManager) return null
    const current = workspaceManager.getCurrent()
    return current ? { path: current.path, name: current.name } : null
  })

  ipcMain.handle('get-recent-workspaces', () => {
    if (!workspaceManager) return []
    return workspaceManager.getRecent()
  })

  ipcMain.handle('open-workspace', () => {
    workspaceCallbacks?.onOpenWorkspace()
  })

  ipcMain.handle('select-workspace', async (_event, dirPath: string) => {
    if (!workspaceCallbacks) return { success: false, error: 'Workspace callbacks not configured' }
    return workspaceCallbacks.onSelectWorkspace(dirPath)
  })

  // Reload only the app UI (renderer); the daemon keeps running on the same port.
  ipcMain.handle('reload-app', () => {
    workspaceCallbacks?.onReloadApp()
  })

  // Restart the daemon against the on-disk binary, then reload the renderer.
  // Used to swap in a freshly rebuilt sidecar without quitting the app.
  ipcMain.handle('restart-daemon', async () => {
    if (!workspaceCallbacks) return { success: false, error: 'Workspace callbacks not configured' }
    return workspaceCallbacks.onRestartDaemon()
  })

  // Detach the session: leave the daemon running and quit the app. Reattach by
  // reopening the same workspace + session in the picker.
  ipcMain.handle('detach-session', () => {
    if (!workspaceCallbacks) return { success: false, error: 'Workspace callbacks not configured' }
    return workspaceCallbacks.onDetachSession()
  })

  // ── Voice prompting ──

  const voiceWorkspaceDir = (): string | undefined =>
    workspaceManager?.getCurrent()?.path

  ipcMain.handle('voice-get-config', () => {
    return publicVoiceConfig(readVoiceConfig(voiceWorkspaceDir()))
  })

  ipcMain.handle(
    'voice-transcribe',
    async (_event, audio: ArrayBuffer, mimeType: string) => {
      return transcribeAudio(audio, mimeType, voiceWorkspaceDir())
    }
  )

  // ── Shell tab-completion ──

  ipcMain.handle(
    'completion-get',
    async (
      _event,
      opts: { shellPid: number; token: string; isFirstToken: boolean; cwd?: string; line?: string }
    ) => {
      return getCompletions(opts)
    }
  )

  // ── Web Pane Management ──

  ipcMain.handle('web-pane-create', (_event, paneId: string, url: string, profile: string, bounds?: WebPaneBounds) => {
    webPaneManager.create(paneId, url, profile, bounds)
    return { success: true }
  })

  ipcMain.handle('web-pane-destroy', (_event, paneId: string) => {
    webPaneManager.destroy(paneId)
    return { success: true }
  })

  ipcMain.handle('web-pane-detach', (_event, paneId: string) => {
    webPaneManager.detach(paneId)
    return { success: true }
  })

  ipcMain.handle('web-pane-sync-alive', (_event, keepIds: string[]) => {
    webPaneManager.syncAlive(keepIds || [])
    return { success: true }
  })

  ipcMain.handle('web-pane-navigate', (_event, paneId: string, url: string) => {
    webPaneManager.navigate(paneId, url)
    return { success: true }
  })

  ipcMain.handle('web-pane-go-back', (_event, paneId: string) => {
    webPaneManager.goBack(paneId)
    return { success: true }
  })

  ipcMain.handle('web-pane-go-forward', (_event, paneId: string) => {
    webPaneManager.goForward(paneId)
    return { success: true }
  })

  ipcMain.handle('web-pane-reload', (_event, paneId: string) => {
    webPaneManager.reload(paneId)
    return { success: true }
  })

  ipcMain.handle('web-pane-set-bounds', (_event, paneId: string, bounds: WebPaneBounds) => {
    webPaneManager.setBounds(paneId, bounds)
    return { success: true }
  })

  ipcMain.handle('web-pane-toggle-devtools', (_event, paneId: string) => {
    webPaneManager.toggleDevTools(paneId)
    return { success: true }
  })

  ipcMain.handle('web-pane-get-content', async (_event, paneId: string) => {
    return await webPaneManager.getPageContent(paneId)
  })

  ipcMain.handle('web-pane-capture-screenshot', async (_event, paneId: string) => {
    const buffer = await webPaneManager.captureScreenshot(paneId)
    return buffer ? buffer.toString('base64') : null
  })

  // Browser-automation: execute an AI-requested browser action on the pane's
  // embedded WebContentsView. Returns {success,result?,error?,screenshot?}.
  ipcMain.handle(
    'web-pane-execute-action',
    async (_event, paneId: string, action: string, params: Record<string, unknown>) => {
      // Always resolve within a bound so a hung action (e.g. capturePage on an
      // occluded view) can't stall the agent's tool for its full 60s timeout —
      // the renderer must reply browser_result promptly with a clear error.
      try {
        return await Promise.race([
          executeBrowserAction(webPaneManager, paneId, action, params || {}),
          new Promise<{ success: boolean; error: string }>((resolve) =>
            setTimeout(
              () => resolve({ success: false, error: `browser action "${action}" timed out in the app after 20s` }),
              20000
            )
          ),
        ])
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('web-pane-clear-session', async (_event, paneId: string) => {
    await webPaneManager.clearSession(paneId)
    return { success: true }
  })

  ipcMain.handle(
    'web-pane-import-cookies',
    async (_event, profile: string, cookies: ImportCookie[]) => {
      const result = await webPaneManager.importCookies(profile, cookies || [])
      return { success: true, ...result }
    }
  )

  ipcMain.handle('web-pane-set-suppressed', (_event, on: boolean) => {
    webPaneManager.setSuppressed(!!on)
    return { success: true }
  })

  ipcMain.handle('web-pane-hide-all', () => {
    webPaneManager.hideAll()
    return { success: true }
  })

  ipcMain.handle('web-pane-show-all', () => {
    webPaneManager.showAll()
    return { success: true }
  })

  ipcMain.handle('web-pane-show-only', (_event, paneIds: string[]) => {
    webPaneManager.showOnly(new Set(paneIds))
    return { success: true }
  })

  ipcMain.handle('web-pane-set-top-most', (_event, paneId: string) => {
    webPaneManager.setTopMost(paneId)
    return { success: true }
  })

  // ── Forward web pane status updates to the renderer ──
  webPaneManager.onStatusUpdate((status) => {
    // Send to all windows (in practice, just the main window)
    const { BrowserWindow } = require('electron')
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('web-pane-status', status)
    }
  })
}
