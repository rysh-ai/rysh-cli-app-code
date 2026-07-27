import { app } from 'electron'
import { join, basename, dirname } from 'path'
import * as fs from 'fs'

// The rysh daemon loads the first of these it finds (YAML preferred; legacy TOML
// `rysh.config` still accepted). Matched against a lowercased basename.
const CONFIG_NAMES = ['rysh.config.yaml', 'rysh.config.yml', 'rysh.config']

export interface WorkspaceInfo {
  path: string
  name: string
  lastOpened: string
  /** The rysh session last opened in this workspace (boot auto-reopen uses it). */
  lastSession?: string
}

const MAX_RECENT = 10

/**
 * WorkspaceManager tracks the current workspace and persists a list
 * of recent workspaces — plus the LAST workspace, which the app reopens by
 * default on the next launch — to userData/workspaces.json.
 *
 * A workspace is a project directory that contains a `rysh.config` file.
 * The `last` pointer is set on every open and cleared by an explicit
 * "Close Workspace", so a fresh instance starts on the empty screen while a
 * relaunch after normal use lands back in the project it left.
 */
export class WorkspaceManager {
  private current: WorkspaceInfo | null = null
  private recent: WorkspaceInfo[] = []
  private last: string | null = null
  private filePath: string

  constructor() {
    this.filePath = join(app.getPath('userData'), 'workspaces.json')
    this.load()
  }

  /**
   * Validate that a directory is a rysh workspace ROOT. The daemon (cwd = root)
   * finds its config in either supported layout:
   *   - sibling:        <root>/rysh.config.yaml      (with .rysh beside it)
   *   - config-in-.rysh: <root>/.rysh/rysh.config.yaml
   */
  validateWorkspace(dirPath: string): boolean {
    return this.dirHasConfig(dirPath) || this.dirHasConfig(join(dirPath, '.rysh'))
  }

  /** Whether dir directly contains a rysh config file. */
  private dirHasConfig(dir: string): boolean {
    try {
      return CONFIG_NAMES.some((n) => fs.existsSync(join(dir, n)))
    } catch {
      return false
    }
  }

  /**
   * Resolve a user-selected path — a rysh.config.* FILE or a DIRECTORY — to the
   * workspace ROOT the daemon should run in (its cwd), or null if it isn't a
   * valid rysh workspace. With cwd = root the daemon finds the config whether it
   * sits beside a .rysh dir or inside one. Mirrors the backend's
   * resolveWorkingDirectory so the app and daemon agree on the root.
   */
  resolveWorkspaceRoot(selectedPath: string): string | null {
    let stat: fs.Stats
    try {
      stat = fs.statSync(selectedPath)
    } catch {
      return null
    }

    // A rysh.config.* file: root is its directory, unless that directory is a
    // `.rysh` dir, in which case root is the parent of `.rysh`.
    if (stat.isFile()) {
      if (!CONFIG_NAMES.includes(basename(selectedPath).toLowerCase())) return null
      const dir = dirname(selectedPath)
      return basename(dir) === '.rysh' ? dirname(dir) : dir
    }

    if (stat.isDirectory()) {
      // The `.rysh` directory itself was selected -> root is its parent.
      if (basename(selectedPath) === '.rysh' && this.dirHasConfig(selectedPath)) {
        return dirname(selectedPath)
      }
      // A project root (config beside it, or inside its `.rysh`).
      if (this.validateWorkspace(selectedPath)) return selectedPath
    }

    return null
  }

  /**
   * Get the current workspace, or null if none is set.
   */
  getCurrent(): WorkspaceInfo | null {
    return this.current
  }

  /**
   * Set the current workspace by directory path.
   */
  setCurrent(dirPath: string): void {
    this.current = {
      path: dirPath,
      name: basename(dirPath),
      lastOpened: new Date().toISOString(),
    }
  }

  /**
   * Clear the current workspace.
   */
  clearCurrent(): void {
    this.current = null
  }

  /**
   * Add a workspace to the recent list (or move it to the top if already
   * present), record the session opened in it, and mark it as the LAST
   * workspace (the one the next launch reopens by default). Persists to disk.
   */
  addRecent(dirPath: string, session?: string): void {
    const name = basename(dirPath)
    const now = new Date().toISOString()

    // Carry the previously recorded session forward when none is given.
    const prev = this.recent.find((w) => w.path === dirPath)
    const lastSession = session?.trim() || prev?.lastSession

    // Remove existing entry for the same path
    this.recent = this.recent.filter((w) => w.path !== dirPath)

    // Add to front
    this.recent.unshift({ path: dirPath, name, lastOpened: now, lastSession })

    // Cap at MAX_RECENT
    if (this.recent.length > MAX_RECENT) {
      this.recent = this.recent.slice(0, MAX_RECENT)
    }

    this.last = dirPath
    this.save()
  }

  /**
   * The workspace to reopen on launch: set on every open, cleared by an
   * explicit Close Workspace. Returns its recent entry (which carries the
   * last session), or null when the app should start on the empty screen.
   */
  getLast(): WorkspaceInfo | null {
    if (!this.last) return null
    return this.recent.find((w) => w.path === this.last) ?? null
  }

  /** Forget the launch-default workspace (explicit Close Workspace). */
  clearLast(): void {
    this.last = null
    this.save()
  }

  /**
   * Get the list of recent workspaces.
   */
  getRecent(): WorkspaceInfo[] {
    return [...this.recent]
  }

  /**
   * Load recent workspaces (and the launch-default pointer) from disk.
   * Legacy format was a bare array of recents; migrating treats the most
   * recent entry as the launch default — "a workspace was loaded before, so
   * open it by default" — matching the new-format behavior for upgraders.
   */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(data)
        if (Array.isArray(parsed)) {
          // Legacy: bare recents array.
          this.recent = parsed
          this.last = parsed[0]?.path ?? null
        } else if (parsed && typeof parsed === 'object') {
          this.recent = Array.isArray(parsed.recent) ? parsed.recent : []
          this.last = typeof parsed.last === 'string' && parsed.last !== '' ? parsed.last : null
        }
      }
    } catch (err) {
      console.warn('[workspaceManager] Failed to load workspaces.json:', err)
      this.recent = []
      this.last = null
    }
  }

  /**
   * Persist recent workspaces and the launch-default pointer to disk.
   */
  private save(): void {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ version: 2, last: this.last, recent: this.recent }, null, 2),
        'utf-8'
      )
    } catch (err) {
      console.warn('[workspaceManager] Failed to save workspaces.json:', err)
    }
  }
}
