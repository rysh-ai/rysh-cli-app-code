import { execFile } from 'child_process'
import { lstatSync, readFileSync } from 'fs'
import { hostname } from 'os'
import { join, relative, resolve, isAbsolute } from 'path'
import { parseConnectLink, type ConnectTarget } from '../src/utils/connectLink'
import { isSandboxDesktopLinkArg } from '../src/utils/sandboxDesktopLink'

/**
 * Company Connect (design 037) — the desktop half of the hand-off.
 *
 * The app never talks to rysh-server itself: it runs the bundled sidecar's
 * `ry connect <server> <code> --json`, which claims the code, writes
 * ~/Rysh/<slug>/rysh.config.yaml, puts the read-only key in
 * ~/Rysh/<slug>/.rysh/secrets/default/RYSH_UPSTREAM_API_KEY (the YAML keeps
 * only the reference ${RYSH_UPSTREAM_API_KEY}; CD2), and prints where it put
 * them. The app checks
 * those files (checkConnectResult), then opens that directory as a workspace
 * with the session named after the company — the same adoption path as any
 * other workspace, so a terminal that connected first is simply adopted, not
 * duplicated.
 */
export interface ConnectResult {
  directory: string
  config_file: string
  secrets_file: string
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

/** The servers a connect link may name without a question (exact host, https, default port). */
const TRUSTED_CONNECT_HOSTS = ['rysh.ai', 'letchat.ai']

export type ConnectServerClass =
  | { kind: 'trusted'; host: string }
  | { kind: 'confirm'; host: string }
  | { kind: 'refuse'; host: string; reason: string }

/**
 * classifyConnectServer decides what the app does with the server a link names
 * (security-lead ledger 157: any web page can craft a rysh://connect link).
 * rysh.ai and letchat.ai over https go on; any other https server, and http to
 * loopback (a local server), need the user's yes; plain http elsewhere and
 * anything that is not an http(s) URL are refused.
 */
export function classifyConnectServer(server: string): ConnectServerClass {
  let url: URL
  try {
    url = new URL(server)
  } catch {
    return { kind: 'refuse', host: server, reason: 'it is not a server address' }
  }
  const host = url.host
  if (url.username || url.password) return { kind: 'refuse', host, reason: 'the address carries a user name or password' }
  if (url.protocol === 'https:') {
    return TRUSTED_CONNECT_HOSTS.includes(host) ? { kind: 'trusted', host } : { kind: 'confirm', host }
  }
  if (url.protocol === 'http:') {
    const h = url.hostname
    if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]') return { kind: 'confirm', host }
    return { kind: 'refuse', host, reason: 'it is plain http, so the one-time code would travel unencrypted' }
  }
  return { kind: 'refuse', host, reason: `${url.protocol} is not http(s)` }
}

/**
 * confirmConnectServer asks the user (through `ask`, a native dialog in main)
 * before a link may connect to a server other than rysh.ai/letchat.ai. It
 * returns null to go on, else the sentence to show. The question names the
 * host and never the one-time code.
 */
export async function confirmConnectServer(
  target: ConnectTarget,
  ask: (message: string, detail: string) => Promise<boolean>
): Promise<string | null> {
  const c = classifyConnectServer(target.server)
  if (c.kind === 'trusted') return null
  if (c.kind === 'refuse') return `Not connecting to ${c.host}: ${c.reason}.`
  const yes = await ask(
    `Connect this app to ${c.host}?`,
    `This link names ${c.host}, which is not rysh.ai. Only continue if you opened it from that server's own company page. ` +
      'The app sends that server only the one-time code from the link.'
  )
  return yes ? null : `Cancelled: not connecting to ${c.host}.`
}

/**
 * connectArgs is the sidecar's argv: the server and the one-time code, nothing stored. The claim is
 * recorded as the desktop app (`--vehicle desktop`; the sidecar is pinned with the app, so it has the flag).
 */
export function connectArgs(target: ConnectTarget, device: string): string[] {
  return ['connect', target.server, target.token, '--json', '--device', device, '--vehicle', 'desktop']
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
      connectArgs(target, deviceLabel()),
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

/** The reference ry connect writes for the key (rysh-cli secrets convention, design 004). */
export const UPSTREAM_KEY_NAME = 'RYSH_UPSTREAM_API_KEY'
const UPSTREAM_KEY_REF = '${' + UPSTREAM_KEY_NAME + '}'

/** Every `api_key: <value>` line at any depth, its value unquoted; an empty `api_key:` is not listed. */
function apiKeyValues(yaml: string): string[] {
  const out: string[] = []
  for (const m of yaml.matchAll(/^\s*-?\s*["']?api_key["']?\s*:\s*([^#\r\n]*)/gm)) {
    const v = m[1].trim().replace(/^(["'])(.*)\1$/, '$2')
    if (v !== '') out.push(v)
  }
  return out
}

function within(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function holdsKeyField(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(holdsKeyField)
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).some(([k, x]) => k.toLowerCase() === 'api_key' || holdsKeyField(x))
  }
  return false
}

function isPrivate(path: string, mode: number, what: string): string | null {
  if ((mode & 0o077) !== 0) return `${path}: ${what} is open to other users (mode ${(mode & 0o777).toString(8)}); it must be private`
  if (typeof process.getuid === 'function' && lstatSync(path).uid !== process.getuid()) return `${path}: ${what} is not owned by this user`
  return null
}

function originOf(u: string): URL | null {
  try {
    return new URL(u)
  } catch {
    return null
  }
}

function isLoopback(u: URL): boolean {
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
}

/**
 * checkOrigin (F-d, security-lead ledger 190): a written server address must be the link's own origin
 * (scheme, host and port), and https unless the link itself was a loopback http server. A connection
 * that would poll with the key over plain http, or talk to another server than the link named, is refused.
 */
function checkOrigin(written: string, linkServer: string, where: string): string | null {
  const w = originOf(written)
  const l = originOf(linkServer)
  if (!w || !l) return `${where} names no usable server address; refusing to open the company`
  if (w.protocol !== 'https:' && !(w.protocol === 'http:' && isLoopback(w))) {
    return `${where} would talk to ${w.host} over plain http, so the company key would travel unencrypted; refusing to open the company. Revoke the key from the dashboard.`
  }
  if (w.origin !== l.origin) return `${where} names ${w.host}, not ${l.host} from the link; refusing to open the company`
  return null
}

/**
 * checkConnectResult checks what the sidecar wrote before the app opens it
 * (CD2), and fails closed. The YAML must hold the reference
 * `upstream.api_key: ${RYSH_UPSTREAM_API_KEY}`, and no api_key anywhere may
 * hold a plain value or any other ref (ledger 167); the key must be <directory>/.rysh/secrets/default/RYSH_UPSTREAM_API_KEY,
 * a regular file of this user's, 0600, with .rysh/secrets and
 * .rysh/secrets/default 0700. It returns null when all hold, else one sentence
 * for the user. It never reads the secrets file and never repeats a key value.
 */
export function checkConnectResult(result: ConnectResult, target: ConnectTarget): string | null {
  if (holdsKeyField(result)) return 'ry connect returned a key in its output; refusing to open the company. Revoke the key from the dashboard.'
  const downgrade = checkOrigin(result.server_url, target.server, 'the connection')
  if (downgrade) return downgrade
  if (!within(result.directory, result.config_file)) return `${result.config_file} is outside the company directory ${result.directory}`
  let config: string
  try {
    config = readFileSync(result.config_file, 'utf8')
  } catch (e) {
    return `cannot read ${result.config_file}: ${(e as NodeJS.ErrnoException).code || 'error'}`
  }
  const values = apiKeyValues(config)
  if (values.some((v) => !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v))) {
    return `${result.config_file} holds a key in plain text; the bundled daemon is too old for this app. Revoke the key from the dashboard and update Rysh.`
  }
  // ledger 167: a ${NAME} ref resolves from every secrets scope and the env, so any other
  // name could hand a stored credential to the config's url. Only the exact upstream ref.
  if (values.some((v) => v !== UPSTREAM_KEY_REF)) {
    return `${result.config_file} names a key other than ${UPSTREAM_KEY_REF}; refusing to open the company`
  }
  // ledger 171 A1: the checks above read `api_key:` lines only. Outside comments, every other
  // mention of api_key (flow style {api_key: …}, a complex key, …) is a form this check
  // cannot read, so it is refused rather than trusted.
  const exact = /^\s*-?\s*["']?api_key["']?\s*:\s*(["']?)\$\{RYSH_UPSTREAM_API_KEY\}\1\s*(#.*)?$/
  if (config.split(/\r?\n/).some((l) => !/^\s*#/.test(l) && /\bapi_key\b/i.test(l) && !exact.test(l))) {
    return `${result.config_file} writes api_key in a form this app cannot check; refusing to open the company`
  }
  // F-d: every server address the config was written with is the link's origin (never http off loopback).
  for (const m of config.matchAll(/^\s*-?\s*["']?(?:url|server|server_url)["']?\s*:\s*["']?(https?:\/\/[^\s"'#]+)/gim)) {
    const bad = checkOrigin(m[1], target.server, result.config_file)
    if (bad) return bad
  }
  if (!values.includes(UPSTREAM_KEY_REF)) {
    return `${result.config_file} has no upstream.api_key: ${UPSTREAM_KEY_REF}, so the daemon cannot find the company key`
  }

  if (!result.secrets_file) return 'ry connect did not say where it put the secrets file; the bundled daemon is too old for this app'
  const secrets = join(resolve(result.directory), '.rysh', 'secrets')
  const scope = join(secrets, 'default')
  const want = join(scope, UPSTREAM_KEY_NAME)
  if (resolve(result.secrets_file) !== want) {
    return `the secrets file must be ${want} (.rysh/secrets/default/${UPSTREAM_KEY_NAME} in the company directory), not ${result.secrets_file}`
  }
  try {
    for (const d of [secrets, scope]) {
      const st = lstatSync(d)
      if (!st.isDirectory()) return `${d} is not a directory`
      const dirErr = isPrivate(d, st.mode, 'the secrets directory (0700)')
      if (dirErr) return dirErr
    }
    const f = lstatSync(want)
    if (!f.isFile()) return `${want} is not a regular file${f.isSymbolicLink() ? ' (a symlink)' : ''}`
    return isPrivate(want, f.mode, 'the secrets file (0600)')
  } catch (e) {
    return `the secrets file ${want} is missing: ${(e as NodeJS.ErrnoException).code || 'error'}`
  }
}

/**
 * A desktop app launched from a rysh pane inherits RYSH_SESSION and friends;
 * the CLI honours them, and the company session must be the slug. Strip them,
 * and RYSH_DIR too: with it, `ry connect` puts the company's secrets under
 * RYSH_DIR instead of <directory>/.rysh (CD2).
 */
export function withoutSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const k of ['RYSH_SESSION', 'RYSH_PANE', 'RYSH_TAB', 'RYSH_STACK', 'RYSH_LANE', 'RYSH_DIR']) delete out[k]
  return out
}

/** The rysh:// links in a launch's argv (Linux/Windows deliver them there). */
export function connectLinksInArgv(argv: string[]): string[] {
  // rr-order-154 C8: sandbox desktop links have their own handler (electron/sandboxDesktop.ts).
  return argv.filter((a) => a.toLowerCase().startsWith('rysh://') && !isSandboxDesktopLinkArg(a))
}
