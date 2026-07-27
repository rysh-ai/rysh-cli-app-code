import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

/** Fixed, instance-independent directory name for shared app state. */
export const SHARED_DIR_NAME = 'rysh-cli-app-shared'

/**
 * A daemon this app deliberately left running (via Detach) so its full
 * in-memory state survives an app quit. Keyed by (cwd, sessionName) — the same
 * pair the SidecarManager spawns with — so a later launch can find and adopt it.
 *
 * The web port is the crux: the app assigns it (RYSH_WEB_PORT) and the renderer
 * connects to the daemon over it, but the Go session record does NOT persist it.
 * So the app must remember it here to reconnect after a quit.
 */
export interface DaemonRecord {
  sessionName: string
  /** Working directory the daemon was spawned in (workspace root, or home). */
  cwd: string
  /** Daemon process PID (detached; outlives this app process). */
  pid: number
  /** Web server port the daemon listens on (what the renderer connects to). */
  webPort: number
  /** ISO timestamp of the last update, for diagnostics. */
  updatedAt: string
  /** Instance slot that recorded this daemon (diagnostics only; 0 = primary). */
  instanceId?: number
}

/** True if a process with this PID currently exists (and we may signal it). */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    // Signal 0 performs error checking without actually sending a signal:
    // throws ESRCH if no such process, EPERM if it exists but isn't ours
    // (still "alive"). Either non-throw or EPERM means the PID is live.
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * DaemonRegistry persists the set of detached-but-running daemons to a JSON
 * file, mirroring WindowStateManager's simple-store approach (electron-store is
 * avoided for ESM bundling reasons).
 *
 * The file lives in a SHARED, instance-independent directory (under appData, not
 * any one instance's userData) so EVERY running instance sees EVERY instance's
 * daemons. This is essential for two reasons:
 *   1. killStaleSidecars reaps orphaned daemons by binary path; without a shared
 *      view, a secondary instance would reap the primary's live daemons (and
 *      vice versa). Listing all instances' live pids in one place keeps each
 *      instance's reaper from touching another's.
 *   2. A daemon detached by one instance can be re-adopted by any later launch,
 *      regardless of which slot it lands on (adoption is keyed by cwd+session,
 *      not by instance).
 *
 * Because several processes share the file, every mutation reloads from disk
 * first and only touches its own (cwd, session) keys, so concurrent writers
 * don't clobber each other.
 */
export class DaemonRegistry {
  private filePath: string
  private records: DaemonRecord[]
  private instanceId: number

  constructor(instanceId = 0) {
    this.instanceId = instanceId
    const sharedDir = join(app.getPath('appData'), SHARED_DIR_NAME)
    mkdirSync(sharedDir, { recursive: true })
    this.filePath = join(sharedDir, 'running-daemons.json')
    this.records = []
    this.load()
    this.migrateLegacy()
  }

  /** (Re)read the shared file into memory. Missing/malformed -> empty. */
  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      this.records = Array.isArray(parsed) ? parsed : []
    } catch {
      this.records = []
    }
  }

  /**
   * One-time migration from the pre-multi-instance location
   * (<userData>/running-daemons.json) into the shared file, so a daemon detached
   * by an older build is still adoptable — and, crucially, is in the shared live
   * set so it isn't reaped on the first post-upgrade launch. Only the primary
   * has a legacy file; secondaries never do.
   */
  private migrateLegacy(): void {
    const legacyPath = join(app.getPath('userData'), 'running-daemons.json')
    if (legacyPath === this.filePath || !existsSync(legacyPath)) return
    try {
      const parsed = JSON.parse(readFileSync(legacyPath, 'utf-8'))
      if (!Array.isArray(parsed) || parsed.length === 0) return
      let changed = false
      for (const rec of parsed as DaemonRecord[]) {
        if (!rec || !rec.sessionName) continue
        if (!this.records.some((r) => this.sameKey(r, rec.cwd, rec.sessionName))) {
          this.records.push(rec)
          changed = true
        }
      }
      if (changed) this.save()
    } catch {
      /* unreadable legacy file — nothing to migrate */
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), 'utf-8')
    } catch (err) {
      console.error('[daemonRegistry] Failed to save:', err)
    }
  }

  private sameKey(r: DaemonRecord, cwd: string, sessionName: string): boolean {
    return r.cwd === cwd && r.sessionName === sessionName
  }

  /** The preserved daemon for (cwd, session), if one is recorded. */
  find(cwd: string, sessionName: string): DaemonRecord | null {
    this.load()
    return this.records.find((r) => this.sameKey(r, cwd, sessionName)) ?? null
  }

  /** A preserved daemon whose process is still alive, or null. */
  findAlive(cwd: string, sessionName: string): DaemonRecord | null {
    const rec = this.find(cwd, sessionName)
    return rec && isPidAlive(rec.pid) ? rec : null
  }

  /** Insert or update the record for (cwd, session). */
  record(rec: DaemonRecord): void {
    this.load() // reload so we don't clobber other instances' concurrent writes
    const stamped: DaemonRecord = { ...rec, instanceId: rec.instanceId ?? this.instanceId }
    const i = this.records.findIndex((r) => this.sameKey(r, rec.cwd, rec.sessionName))
    if (i >= 0) this.records[i] = stamped
    else this.records.push(stamped)
    this.save()
  }

  /** Drop the record for (cwd, session) — e.g. after the daemon is stopped. */
  remove(cwd: string, sessionName: string): void {
    this.load()
    const before = this.records.length
    this.records = this.records.filter((r) => !this.sameKey(r, cwd, sessionName))
    if (this.records.length !== before) this.save()
  }

  /** Remove records whose process is no longer alive; returns the survivors. */
  prune(): DaemonRecord[] {
    this.load()
    const before = this.records.length
    this.records = this.records.filter((r) => isPidAlive(r.pid))
    if (this.records.length !== before) this.save()
    return this.records
  }

  /**
   * PIDs of all live preserved daemons across ALL instances. killStaleSidecars
   * excludes these so neither a deliberately-detached daemon nor another running
   * instance's daemon is reaped when an instance starts.
   */
  alivePids(): number[] {
    return this.prune().map((r) => r.pid)
  }
}
