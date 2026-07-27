/**
 * Type declarations for the Electron preload API exposed via contextBridge.
 * Available as `window.electronAPI` in the renderer process.
 */

interface WebPaneStatus {
  paneId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

interface ImportCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

interface WorkspaceInfo {
  path: string
  name: string
  lastOpened: string
  lastSession?: string
}

interface ElectronAPI {
  getPort: () => Promise<number>
  getPlatform: () => Promise<string>
  getSessionName: () => Promise<string>
  getSidecarStatus: () => Promise<{ running: boolean; port: number; sessionName: string }>
  reloadApp: () => Promise<void>
  restartDaemon: () => Promise<{ success: boolean; error?: string }>
  detachSession: () => Promise<{ success: boolean; error?: string }>

  voice: {
    getConfig: () => Promise<{ enabled: boolean; provider: string; hotkey: string; language: string }>
    transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<{ transcript?: string; error?: string }>
  }

  completion: {
    get: (opts: {
      shellPid: number
      token: string
      isFirstToken: boolean
      cwd?: string
      line?: string
    }) => Promise<{ candidates: { value: string; isDir: boolean }[] }>
  }

  workspace: {
    getCurrent: () => Promise<{ path: string; name: string } | null>
    getRecent: () => Promise<WorkspaceInfo[]>
    open: () => Promise<void>
    select: (path: string) => Promise<{ success: boolean; error?: string }>
    onChanged: (callback: (info: { path: string; name: string; port: number }) => void) => void
    removeChangedListener: () => void
  }

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
    onStatusUpdate: (callback: (status: WebPaneStatus) => void) => void
    removeStatusListener: () => void
  }
}

interface Window {
  electronAPI?: ElectronAPI
}
