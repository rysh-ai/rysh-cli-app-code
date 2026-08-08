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
  /**
   * Which front-end CREATED the session: 'app' (rysh desktop app) or 'cli'
   * (rysh command line). This is provenance, not ownership — the app opens
   * either kind. It is kept because the app is a superset of the terminal, so
   * a session created here may use surfaces a terminal cannot paint, and the
   * picker labels the origin so the user knows what they are joining.
   */
  source: 'app' | 'cli'
  /**
   * Live desktop-app (WebSocket) clients connected to the session's daemon.
   * > 0 means another app window is attached to it right now.
   */
  appClients: number
  /** The daemon process, or 0 when the session is stopped. */
  pid: number
  /**
   * The daemon's live loopback web-server port, or 0 when it has none. This is
   * the app's door into a daemon it did not spawn: the renderer speaks only
   * HTTP/WebSocket, so a session with no web server is unreachable until one is
   * started (see ensureWebEndpoint in sidecar.ts). App-created daemons always
   * have one; command-line ones start theirs on demand.
   */
  webPort: number
}

/** Shape of the JSON the daemon writes (snake_case keys). */
interface RawRecord {
  name?: string
  state?: string
  updated_at?: string
  source?: string
  app_clients?: number
  pid?: number
  web_port?: number
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
        pid: typeof rec.pid === 'number' ? rec.pid : 0,
        webPort: typeof rec.web_port === 'number' ? rec.web_port : 0,
      })
    } catch {
      // Skip unreadable / malformed records.
    }
  }

  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return sessions
}

/**
 * Every session in the workspace, whichever front-end created it — the set the
 * picker offers.
 *
 * This used to filter to `source === 'app'`, because the two front-ends refused
 * to open each other's sessions. They no longer do: both drive the same daemon
 * over the same subjects, and the desktop app is a strict superset of the
 * terminal's render surfaces, so it opens a command-line session with nothing
 * lost. The picker labels each session's origin instead of hiding half of them.
 */
export function listOpenableSessions(workspaceRoot: string): AppSession[] {
  return listSessions(workspaceRoot)
}

/** The existing record for `name` in this workspace, or null. */
export function findSession(workspaceRoot: string, name: string): AppSession | null {
  return listSessions(workspaceRoot).find((s) => s.name === name) ?? null
}
