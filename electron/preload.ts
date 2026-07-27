import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload script — exposes a safe API to the renderer process
 * via contextBridge. The renderer accesses this as `window.electronAPI`.
 */

/** One cookie to import into a web profile's session (see webPane.importCookies). */
export interface ImportCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

export interface WorkspaceInfo {
  path: string
  name: string
  lastOpened: string
  lastSession?: string
}

export interface ElectronAPI {
  // App info
  getPort: () => Promise<number>
  getPlatform: () => Promise<string>
  getSessionName: () => Promise<string>
  getSidecarStatus: () => Promise<{ running: boolean; port: number; sessionName: string }>

  // Reload only the app UI (renderer); the daemon keeps running.
  reloadApp: () => Promise<void>
  // Restart the daemon (picks up a freshly built binary) and reload the app.
  restartDaemon: () => Promise<{ success: boolean; error?: string }>
  // Detach: leave the daemon running and quit the app (state preserved).
  detachSession: () => Promise<{ success: boolean; error?: string }>

  // Voice prompting
  voice: {
    getConfig: () => Promise<{ enabled: boolean; provider: string; hotkey: string; language: string }>
    transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<{ transcript?: string; error?: string }>
  }

  // Shell tab-completion
  completion: {
    get: (opts: { shellPid: number; token: string; isFirstToken: boolean }) => Promise<{ candidates: { value: string; isDir: boolean }[] }>
  }

  // Workspace management
  workspace: {
    getCurrent: () => Promise<{ path: string; name: string } | null>
    getRecent: () => Promise<WorkspaceInfo[]>
    open: () => Promise<void>
    select: (path: string) => Promise<{ success: boolean; error?: string }>
    onChanged: (callback: (info: { path: string; name: string; port: number }) => void) => void
    removeChangedListener: () => void
  }

  // Web pane management
  webPane: {
    create: (paneId: string, url: string, profile: string, bounds?: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean }>
    destroy: (paneId: string) => Promise<{ success: boolean }>
    detach: (paneId: string) => Promise<{ success: boolean }>
    syncAlive: (keepIds: string[]) => Promise<{ success: boolean }>
    navigate: (paneId: string, url: string) => Promise<{ success: boolean }>
    goBack: (paneId: string) => Promise<{ success: boolean }>
    goForward: (paneId: string) => Promise<{ success: boolean }>
    reload: (paneId: string) => Promise<{ success: boolean }>
    setBounds: (paneId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean }>
    toggleDevTools: (paneId: string) => Promise<{ success: boolean }>
    getContent: (paneId: string) => Promise<{ title: string; text: string; url: string } | null>
    captureScreenshot: (paneId: string) => Promise<string | null>
    executeAction: (paneId: string, action: string, params: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string; screenshot?: string }>
    clearSession: (paneId: string) => Promise<{ success: boolean }>
    importCookies: (profile: string, cookies: ImportCookie[]) => Promise<{ success: boolean; set?: number; failed?: number }>
    setSuppressed: (on: boolean) => Promise<{ success: boolean }>
    hideAll: () => Promise<{ success: boolean }>
    showAll: () => Promise<{ success: boolean }>
    showOnly: (paneIds: string[]) => Promise<{ success: boolean }>
    setTopMost: (paneId: string) => Promise<{ success: boolean }>
    onStatusUpdate: (callback: (status: {
      paneId: string
      url: string
      title: string
      canGoBack: boolean
      canGoForward: boolean
      loading: boolean
    }) => void) => void
    removeStatusListener: () => void
  }
}

const api: ElectronAPI = {
  // App info
  getPort: () => ipcRenderer.invoke('get-sidecar-port'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getSessionName: () => ipcRenderer.invoke('get-session-name'),
  getSidecarStatus: () => ipcRenderer.invoke('get-sidecar-status'),
  reloadApp: () => ipcRenderer.invoke('reload-app'),
  restartDaemon: () => ipcRenderer.invoke('restart-daemon'),
  detachSession: () => ipcRenderer.invoke('detach-session'),

  // Workspace management
  workspace: {
    getCurrent: () => ipcRenderer.invoke('get-workspace'),
    getRecent: () => ipcRenderer.invoke('get-recent-workspaces'),
    open: () => ipcRenderer.invoke('open-workspace'),
    select: (path) => ipcRenderer.invoke('select-workspace', path),
    onChanged: (callback) => {
      ipcRenderer.on('workspace-changed', (_event, info) => callback(info))
    },
    removeChangedListener: () => {
      ipcRenderer.removeAllListeners('workspace-changed')
    },
  },

  // Voice prompting
  voice: {
    getConfig: () => ipcRenderer.invoke('voice-get-config'),
    transcribe: (audio, mimeType) => ipcRenderer.invoke('voice-transcribe', audio, mimeType),
  },

  // Shell tab-completion
  completion: {
    get: (opts) => ipcRenderer.invoke('completion-get', opts),
  },

  // Web pane management
  webPane: {
    create: (paneId, url, profile, bounds) => ipcRenderer.invoke('web-pane-create', paneId, url, profile, bounds),
    detach: (paneId) => ipcRenderer.invoke('web-pane-detach', paneId),
    syncAlive: (keepIds) => ipcRenderer.invoke('web-pane-sync-alive', keepIds),
    destroy: (paneId) => ipcRenderer.invoke('web-pane-destroy', paneId),
    navigate: (paneId, url) => ipcRenderer.invoke('web-pane-navigate', paneId, url),
    goBack: (paneId) => ipcRenderer.invoke('web-pane-go-back', paneId),
    goForward: (paneId) => ipcRenderer.invoke('web-pane-go-forward', paneId),
    reload: (paneId) => ipcRenderer.invoke('web-pane-reload', paneId),
    setBounds: (paneId, bounds) => ipcRenderer.invoke('web-pane-set-bounds', paneId, bounds),
    toggleDevTools: (paneId) => ipcRenderer.invoke('web-pane-toggle-devtools', paneId),
    getContent: (paneId) => ipcRenderer.invoke('web-pane-get-content', paneId),
    captureScreenshot: (paneId) => ipcRenderer.invoke('web-pane-capture-screenshot', paneId),
    executeAction: (paneId, action, params) => ipcRenderer.invoke('web-pane-execute-action', paneId, action, params),
    clearSession: (paneId) => ipcRenderer.invoke('web-pane-clear-session', paneId),
    importCookies: (profile, cookies) => ipcRenderer.invoke('web-pane-import-cookies', profile, cookies),
    setSuppressed: (on) => ipcRenderer.invoke('web-pane-set-suppressed', on),
    hideAll: () => ipcRenderer.invoke('web-pane-hide-all'),
    showAll: () => ipcRenderer.invoke('web-pane-show-all'),
    showOnly: (paneIds) => ipcRenderer.invoke('web-pane-show-only', paneIds),
    setTopMost: (paneId) => ipcRenderer.invoke('web-pane-set-top-most', paneId),
    onStatusUpdate: (callback) => {
      ipcRenderer.on('web-pane-status', (_event, status) => callback(status))
    },
    removeStatusListener: () => {
      ipcRenderer.removeAllListeners('web-pane-status')
    },
  },
}

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', api)
