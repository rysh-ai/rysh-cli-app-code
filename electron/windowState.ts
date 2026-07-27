import { BrowserWindow, screen, app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

/**
 * Simple JSON-file-backed store for window state.
 * Replaces electron-store to avoid ESM bundling issues.
 */
class JsonStore {
  private filePath: string
  private data: { bounds: WindowBounds | null }

  constructor() {
    const userDataPath = app.getPath('userData')
    mkdirSync(userDataPath, { recursive: true })
    this.filePath = join(userDataPath, 'window-state.json')
    this.data = { bounds: null }

    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      this.data = JSON.parse(raw)
    } catch {
      // File doesn't exist or is invalid — use defaults
    }
  }

  get(key: 'bounds'): WindowBounds | null {
    return this.data[key] ?? null
  }

  set(key: 'bounds', value: WindowBounds): void {
    this.data[key] = value
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      console.error('[windowState] Failed to save:', err)
    }
  }
}

/**
 * WindowStateManager persists and restores window position, size,
 * and maximized state across app restarts.
 */
export class WindowStateManager {
  private store: JsonStore
  private saveTimeout: ReturnType<typeof setTimeout> | null = null
  private window: BrowserWindow | null = null

  constructor() {
    this.store = new JsonStore()
  }

  /**
   * Get saved window bounds, validated against current display geometry.
   * Returns null if no saved bounds or if they're off-screen.
   */
  getBounds(): WindowBounds | null {
    const bounds = this.store.get('bounds')
    if (!bounds) return null

    // Validate that the saved position is within a visible display
    const displays = screen.getAllDisplays()
    const isVisible = displays.some((display) => {
      const { x, y, width, height } = display.bounds
      return (
        bounds.x >= x - 100 &&
        bounds.y >= y - 100 &&
        bounds.x < x + width + 100 &&
        bounds.y < y + height + 100
      )
    })

    if (!isVisible) {
      console.log('[windowState] Saved bounds are off-screen, ignoring')
      return null
    }

    return bounds
  }

  /**
   * Start tracking a window's position and size changes.
   */
  track(window: BrowserWindow): void {
    this.window = window

    const debouncedSave = (): void => {
      if (this.saveTimeout) clearTimeout(this.saveTimeout)
      this.saveTimeout = setTimeout(() => this.save(), 500)
    }

    window.on('resize', debouncedSave)
    window.on('move', debouncedSave)
    window.on('maximize', debouncedSave)
    window.on('unmaximize', debouncedSave)
  }

  /**
   * Save the current window state to disk.
   */
  save(): void {
    if (!this.window || this.window.isDestroyed()) return

    const isMaximized = this.window.isMaximized()
    const bounds = this.window.getNormalBounds()

    this.store.set('bounds', {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
    })
  }
}
