import { execFile } from 'child_process'
import { hostname } from 'os'
import { parseConnectLink, type ConnectTarget } from '../src/utils/connectLink'

/**
 * Company Connect (design 037) — the desktop half of the hand-off.
 *
 * The app never talks to rysh-server itself: it runs the bundled sidecar's
 * `ry connect <server> <code> --json`, which claims the code, writes
 * ~/Rysh/<slug>/rysh.config.yaml with the read-only key, and prints where it
 * put it. The app then opens that directory as a workspace with the session
 * named after the company — the same adoption path as any other workspace, so
 * a terminal that connected first is simply adopted, not duplicated.
 */
export interface ConnectResult {
  directory: string
  config_file: string
  session: string
  server_url: string
  workspace_id: string
  company: { id: string; name: string; slug: string; fqdn: string; status: string }
}

export { parseConnectLink }
export type { ConnectTarget }

/** The label the dashboard shows under "Connected devices". */
export function deviceLabel(): string {
  const host = hostname() || 'this machine'
  return `Rysh Desktop on ${host}`
}

/**
 * runConnect claims the code through the sidecar. Errors carry the server's
 * own sentence (`ry connect` prints it on stderr), so a used or expired code
 * reads as exactly that.
 */
export function runConnect(binary: string, target: ConnectTarget, timeoutMs = 30_000): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['connect', target.server, target.token, '--json', '--device', deviceLabel()],
      { timeout: timeoutMs, maxBuffer: 1 << 20, env: withoutSessionEnv(process.env) },
      (err, stdout, stderr) => {
        if (err) {
          const text = (stderr || '').trim() || err.message
          // `ry: http://…: connect code is invalid, expired or already used`
          reject(new Error(text.replace(/^ry(sh)?:\s*/, '')))
          return
        }
        try {
          const parsed = JSON.parse(stdout) as ConnectResult
          if (!parsed.directory || !parsed.session) throw new Error('missing directory or session')
          resolve(parsed)
        } catch (e) {
          reject(new Error(`ry connect returned something unexpected: ${(e as Error).message}`))
        }
      }
    )
  })
}

/**
 * A desktop app launched from a rysh pane inherits RYSH_SESSION and friends;
 * the CLI honours them, and the company session must be the slug. Strip them.
 */
export function withoutSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const k of ['RYSH_SESSION', 'RYSH_PANE', 'RYSH_TAB', 'RYSH_STACK', 'RYSH_LANE']) delete out[k]
  return out
}

/** The rysh:// links in a launch's argv (Linux/Windows deliver them there). */
export function connectLinksInArgv(argv: string[]): string[] {
  return argv.filter((a) => a.toLowerCase().startsWith('rysh://'))
}
