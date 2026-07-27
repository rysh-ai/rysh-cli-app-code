import { join } from 'path'
import * as fs from 'fs'

/**
 * A session record as written by the rysh daemon under
 * <workspaceRoot>/.rysh/sessions/<name>.json. Only the fields the app needs.
 */
export interface AppSession {
  name: string
  state: string
  updatedAt: string
  /** 'app' (rysh desktop app) or 'cli' (rysh command line). */
  source: 'app' | 'cli'
  /**
   * Live desktop-app (WebSocket) clients connected to the session's daemon.
   * > 0 means another app window is attached to it right now.
   */
  appClients: number
}

/** Shape of the JSON the daemon writes (snake_case keys). */
interface RawRecord {
  name?: string
  state?: string
  updated_at?: string
  source?: string
  app_clients?: number
}

/**
 * <workspaceRoot>/.rysh/sessions — where the daemon writes session records.
 * The app spawns the daemon with cwd = workspaceRoot, so its RyshDir resolves
 * to <workspaceRoot>/.rysh and its session registry to .rysh/sessions, for both
 * the `rysh.config.yaml`-beside-`.rysh` and config-inside-`.rysh` layouts.
 */
function sessionsDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.rysh', 'sessions')
}

/**
 * Read and parse every session record under <workspaceRoot>/.rysh/sessions,
 * most-recently-updated first. Missing/empty directory → []. Unreadable or
 * malformed records are skipped.
 */
export function listSessions(workspaceRoot: string): AppSession[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(sessionsDir(workspaceRoot))
  } catch {
    return [] // no .rysh/sessions yet
  }

  const sessions: AppSession[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = fs.readFileSync(join(sessionsDir(workspaceRoot), entry), 'utf-8')
      const rec = JSON.parse(raw) as RawRecord
      if (!rec.name) continue
      sessions.push({
        name: rec.name,
        state: rec.state ?? 'unknown',
        updatedAt: rec.updated_at ?? '',
        // Blank/legacy records are command-line sessions, matching the Go
        // side's session.NormalizeSource (only "app" is the app).
        source: rec.source === 'app' ? 'app' : 'cli',
        appClients: typeof rec.app_clients === 'number' ? rec.app_clients : 0,
      })
    } catch {
      // Skip unreadable / malformed records.
    }
  }

  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return sessions
}

/**
 * Sessions this app owns (source === 'app'). These are the only ones the picker
 * offers; the app never opens command-line sessions.
 */
export function listAppSessions(workspaceRoot: string): AppSession[] {
  return listSessions(workspaceRoot).filter((s) => s.source === 'app')
}

/** The existing record for `name` in this workspace, or null. */
export function findSession(workspaceRoot: string, name: string): AppSession | null {
  return listSessions(workspaceRoot).find((s) => s.name === name) ?? null
}
