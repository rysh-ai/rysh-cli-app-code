import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ConnectTarget } from '../src/utils/connectLink'

/**
 * S2.3 (design 037, plan v4 R4): the connect file, the fallback when the browser
 * does not hand the rysh://connect link to the app. The company page offers
 * rysh-connect-<slug>.ryshconnect (rysh-server POST /:id/connect-file); the
 * format is agreed with the server (S2.2) and `ry connect --file` (S2.5):
 *
 *   {"rysh_connect":1,"server":"<origin>","code":"rysh_ct_<48 hex>",
 *    "company":{"name":"…","slug":"…"},"expires_at":"<RFC3339 UTC>"}
 *
 * It holds a one-time code (a credential), never a key: a file with any other
 * field, a field named like a key, or any rysh_ string besides the code is
 * refused. On first launch the primary instance picks up the newest fresh file
 * from Downloads/Desktop, asks one question naming the company and the server,
 * claims it through the same path as a link, and deletes the file only after a
 * good claim. Nothing here prints or returns the code.
 */
export const CONNECT_FILE_EXT = '.ryshconnect'
/** The code lives 30 minutes; a file older than that is never picked up on its own. */
export const CONNECT_FILE_MAX_AGE_MS = 30 * 60_000
const MAX_BYTES = 4096
/** A download's mtime may run slightly ahead of this clock; more than this is not a fresh download. */
const FUTURE_SLACK_MS = 60_000

export interface ConnectFileCompany {
  name: string
  slug: string
}
export type ConnectFileParse =
  | { ok: true; target: ConnectTarget; company: ConnectFileCompany }
  | { ok: false; reason: string }

const CODE_RE = /^rysh_ct_[0-9a-f]{48}$/
const FIELDS = ['rysh_connect', 'server', 'code', 'company', 'expires_at']
const KEY_NAMES = ['api_key', 'key', 'secret', 'token']

function refuse(reason: string): ConnectFileParse {
  return { ok: false, reason }
}

/** A field named like a key, or a rysh_ string (workspace keys are rysh_ + random), anywhere but the code. */
function keyShaped(v: unknown, top = true): boolean {
  if (typeof v === 'string') return v.startsWith('rysh_')
  if (Array.isArray(v)) return v.some((x) => keyShaped(x, false))
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).some(
      ([k, x]) => KEY_NAMES.includes(k.toLowerCase()) || (!(top && k === 'code') && keyShaped(x, false))
    )
  }
  return false
}

function checkServer(server: unknown): string | null {
  if (typeof server !== 'string') return 'it names no server'
  let url: URL
  try {
    url = new URL(server)
  } catch {
    return 'its server is not an address'
  }
  if (url.origin === 'null' || server !== url.origin) return 'its server must be an address with no path, user or query'
  if (url.protocol === 'https:') return null
  const h = url.hostname
  if (url.protocol === 'http:' && (h === '127.0.0.1' || h === 'localhost' || h === '[::1]')) return null
  return 'its server is not https, so the one-time code would travel unencrypted'
}

/** parseConnectFile checks a file's text against the agreed format; `now` is ms since the epoch. */
export function parseConnectFile(text: string, now: number): ConnectFileParse {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return refuse('it is larger than a connect file can be')
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return refuse('it is not a connect file')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return refuse('it is not a connect file')
  const o = v as Record<string, unknown>
  if (o.rysh_connect !== 1) return refuse('it is not a version this app reads')
  if (Object.keys(o).some((k) => !FIELDS.includes(k))) return refuse('it holds fields a connect file never has')
  if (keyShaped(o)) return refuse('it holds something shaped like a key; a connect file never does')
  if (typeof o.code !== 'string' || !CODE_RE.test(o.code)) return refuse('it holds no valid one-time code')
  const bad = checkServer(o.server)
  if (bad) return refuse(bad)
  const c = o.company as Record<string, unknown> | null
  if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name.trim() || typeof c.slug !== 'string') {
    return refuse('it names no company')
  }
  const exp = typeof o.expires_at === 'string' ? Date.parse(o.expires_at) : NaN
  if (Number.isNaN(exp)) return refuse('its expiry is unreadable')
  if (exp <= now) return refuse('its one-time code has expired; download a new one from the company page')
  return { ok: true, target: { server: o.server as string, token: o.code }, company: { name: c.name.trim(), slug: c.slug } }
}

/**
 * isFirstLaunchForPickup: the pickup runs once, on a fresh install (no marker, no
 * workspace ever opened). macOS asks the user before any app lists Downloads or
 * Desktop, so an existing user (e.g. after an update) is never asked; later
 * files go through the link or "Choose connect file…" (no prompt: the user picks).
 */
export function isFirstLaunchForPickup(marker: string, recentCount: number): boolean {
  return recentCount === 0 && !existsSync(marker)
}

/** markPickupDone records that the first-launch pickup has run (best effort). */
export function markPickupDone(marker: string): void {
  try {
    writeFileSync(marker, new Date().toISOString() + '\n', { mode: 0o600 })
  } catch {
    /* without the marker the next launch looks once more; harmless */
  }
}

/** Where a browser puts the download, in the order looked at. */
export function connectFileDirs(home: string): string[] {
  return [join(home, 'Downloads'), join(home, 'Desktop')]
}

/**
 * A regular file (never a symlink), this user's, small, and writable by no one
 * else. Browsers save downloads 0644, so readable-by-others is accepted: the
 * file holds only a one-time 30-minute code, never a key, and macOS keeps
 * ~/Downloads and ~/Desktop private to the user.
 */
function ownRegular(path: string): { mtimeMs: number } | null {
  try {
    const st = lstatSync(path)
    if (!st.isFile() || (st.mode & 0o022) !== 0 || st.size > MAX_BYTES) return null
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null
    return { mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/** findConnectFile returns the newest *.ryshconnect in `dirs` (not recursive) at most 30 minutes old, else null. */
export function findConnectFile(dirs: readonly string[], now: number): string | null {
  let best: { path: string; mtimeMs: number } | null = null
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(CONNECT_FILE_EXT)) continue
      const path = join(dir, name)
      const st = ownRegular(path)
      if (!st) continue
      const age = now - st.mtimeMs
      if (age > CONNECT_FILE_MAX_AGE_MS || age < -FUTURE_SLACK_MS) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { path, mtimeMs: st.mtimeMs }
    }
  }
  return best ? best.path : null
}

/** readConnectFile reads one file without following a symlink, and parses it. */
export function readConnectFile(path: string, now: number): ConnectFileParse {
  if (!ownRegular(path)) return refuse('it is not a regular file of this user that only this user can change')
  let text = ''
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      if (fstatSync(fd).size > MAX_BYTES) return refuse('it is larger than a connect file can be')
      text = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
  } catch (e) {
    return refuse(`it cannot be read (${(e as NodeJS.ErrnoException).code || 'error'})`)
  }
  return parseConnectFile(text, now)
}

/** The one question: names the company and the server host, never the code. */
export function connectFilePrompt(company: ConnectFileCompany, server: string): { message: string; detail: string } {
  let host = server
  try {
    host = new URL(server).host
  } catch {
    /* parseConnectFile already checked it */
  }
  return {
    message: `Connect this app to ${company.name}?`,
    detail:
      `A connect file from the company page on ${host} was downloaded in the last 30 minutes. ` +
      'Connecting gives this machine a key for that company only, which you can revoke on the dashboard. ' +
      'The file is deleted once the company is connected.',
  }
}

export type ConnectFileOutcome =
  | { kind: 'none' }
  | { kind: 'refused'; path: string; reason: string }
  | { kind: 'declined'; path: string }
  | { kind: 'claimed'; path: string }
  | { kind: 'failed'; path: string; error: string }

export interface ClaimDeps {
  now: number
  /** Shows the question; true = connect. */
  ask: (message: string, detail: string) => Promise<boolean>
  /** Claims the code through the same path as a link (server confirm, --vehicle desktop, result checks). */
  claim: (target: ConnectTarget) => Promise<{ success: boolean; error?: string }>
}

/**
 * claimConnectFile asks, claims and deletes one file (the one picked up, or the
 * one the user chose in the file dialog). The file is removed only after a good
 * claim; a refusal, a no or a failed claim leaves it where it is.
 */
export async function claimConnectFile(path: string, deps: ClaimDeps): Promise<ConnectFileOutcome> {
  const parsed = readConnectFile(path, deps.now)
  if (!parsed.ok) return { kind: 'refused', path, reason: parsed.reason }
  const q = connectFilePrompt(parsed.company, parsed.target.server)
  if (!(await deps.ask(q.message, q.detail))) return { kind: 'declined', path }
  let res: { success: boolean; error?: string }
  try {
    res = await deps.claim(parsed.target)
  } catch (e) {
    return { kind: 'failed', path, error: (e as Error).message || String(e) }
  }
  if (!res.success) return { kind: 'failed', path, error: res.error || 'the company could not be connected' }
  try {
    unlinkSync(path)
  } catch {
    /* already gone; the code is used either way */
  }
  return { kind: 'claimed', path }
}

/** pickUpConnectFile: the first-launch pickup. `skip` holds files already answered in this run. */
export async function pickUpConnectFile(opts: ClaimDeps & { dirs: readonly string[]; skip?: ReadonlySet<string> }): Promise<ConnectFileOutcome> {
  const path = findConnectFile(opts.dirs, opts.now)
  if (!path || opts.skip?.has(path)) return { kind: 'none' }
  return claimConnectFile(path, opts)
}
