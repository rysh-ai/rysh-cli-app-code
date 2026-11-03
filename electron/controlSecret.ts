import { randomBytes } from 'crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'

/**
 * The per-launch secret for the desktop app's local connection to its daemon.
 *
 * The app's main process makes one secret per daemon it starts and hands it to
 * the daemon through a 0600 file whose PATH is in the environment (or, for a
 * live daemon asked to open a door, on `rysh web start --control-secret-file`).
 * The secret itself is never in argv, a URL or a log line. The app keeps its
 * copy in the 0600 daemon registry so a detached daemon can be re-adopted.
 *
 * The renderer never holds it: main attaches it as a request header, only for
 * the app window's own requests to that daemon's exact address (see
 * installControlSecretHeader). Web panes live in other session partitions and
 * never pass through this hook.
 */

/** Env name the daemon reads the handover file path from (agreed with cli-core). */
export const CONTROL_SECRET_FILE_ENV = 'RYSH_WEB_CONTROL_SECRET_FILE'
/** Flag on `rysh web start` naming the handover file for a live daemon. */
export const CONTROL_SECRET_FILE_FLAG = '--control-secret-file'
/** Request header the daemon checks on HTTP and on the /ws handshake. */
export const CONTROL_SECRET_HEADER = 'X-Rysh-Control-Secret'

const SECRET_BYTES = 32
const HOST = '127.0.0.1'

/** A new secret: 32 random bytes, base64url. */
export function makeControlSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

/**
 * Write the secret to a new 0600 file in `dir` (created or tightened to 0700)
 * and return its path. The name is random and unrelated to the secret.
 */
export function writeHandoverFile(dir: string, secret: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = join(dir, `handover-${randomBytes(12).toString('hex')}`)
  // 'wx': never follow or reuse an existing file at that name.
  writeFileSync(path, secret + '\n', { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
  return path
}

const HANDOVER_DIR_PREFIX = 'rysh-handover-'

/**
 * A new private (0700) dir for one handover file, under the OS temp dir. Not
 * under appData: on macOS that is ".../Application Support", and the
 * --control-secret-file path is typed into a pane, where a space breaks it
 * (the CLI refuses a path with whitespace).
 */
export function makeHandoverDir(): string {
  return mkdtempSync(join(tmpdir(), HANDOVER_DIR_PREFIX))
}

/** True when a path would break once typed into a pane. */
export function hasWhitespace(path: string): boolean {
  return /\s/.test(path)
}

/**
 * Delete a handover file, and its own temp dir when it is one of ours; quiet
 * when the daemon already deleted the file.
 */
export function removeHandoverFile(path: string | null | undefined): void {
  if (!path) return
  try {
    unlinkSync(path)
  } catch {
    /* already gone */
  }
  const dir = dirname(path)
  if (basename(dir).startsWith(HANDOVER_DIR_PREFIX)) {
    try {
      rmdirSync(dir)
    } catch {
      /* not empty or already gone */
    }
  }
}

/**
 * Read a secret the daemon wrote for itself (a command-line `--control` door).
 * Returns null unless it is a regular file (not a symlink) owned by this user,
 * with no group/other bits, holding one base64url line of at least 32 bytes.
 */
export function readSecretFile(path: string | null | undefined): string | null {
  if (!path) return null
  try {
    const st = lstatSync(path)
    if (!st.isFile()) return null
    if ((st.mode & 0o077) !== 0) return null
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null
    const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l !== '')
    if (lines.length !== 1) return null
    const s = lines[0].trim()
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
    if (Buffer.from(s, 'base64url').length < SECRET_BYTES) return null
    return s
  } catch {
    return null
  }
}

/** The one request that may carry the secret: this window, this daemon. */
export interface ControlTarget {
  /** webContents id of the app window (never the session picker or a pane). */
  webContentsId: number
  /** The daemon's loopback web port. */
  port: number
  /** The daemon's secret; empty = none known (an old daemon needs none). */
  secret: string
}

/**
 * The secret to attach to a request, or null. Only for the target window's
 * requests to http:// or ws:// 127.0.0.1:<that port> exactly.
 */
export function controlHeaderFor(
  url: string,
  webContentsId: number | undefined,
  target: ControlTarget | null
): string | null {
  if (!target || !target.secret || !(target.port > 0)) return null
  if (webContentsId === undefined || webContentsId < 0 || webContentsId !== target.webContentsId) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'ws:') return null
  if (u.username || u.password) return null
  if (u.hostname !== HOST) return null
  if (u.port !== String(target.port)) return null
  return target.secret
}

interface HeaderDetails {
  url: string
  webContentsId?: number
  requestHeaders: Record<string, string>
}
interface SessionLike {
  webRequest: {
    onBeforeSendHeaders: (
      listener: (details: HeaderDetails, callback: (response: { requestHeaders: Record<string, string> }) => void) => void
    ) => void
  }
}

/**
 * Attach the secret header to the target request on `ses` (the app window's
 * default session). `getTarget` is read on every request, so a workspace switch
 * (new daemon, new port, new secret) needs no re-install. Any same-named header
 * on any other request is dropped. Electron keeps one onBeforeSendHeaders
 * listener per session, so this must be the only one on the default session.
 */
export function installControlSecretHeader(ses: SessionLike, getTarget: () => ControlTarget | null): void {
  const lower = CONTROL_SECRET_HEADER.toLowerCase()
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(details.requestHeaders)) {
      if (k.toLowerCase() !== lower) headers[k] = v
    }
    let secret: string | null = null
    try {
      secret = controlHeaderFor(details.url, details.webContentsId, getTarget())
    } catch {
      secret = null
    }
    if (secret) headers[CONTROL_SECRET_HEADER] = secret
    callback({ requestHeaders: headers })
  })
}
