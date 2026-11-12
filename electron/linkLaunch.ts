import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { parseConnectLink } from '../src/utils/connectLink'
import { parseSandboxDesktopLink } from '../src/utils/sandboxDesktopLink'

/**
 * CD4 (design 037 on Linux): macOS hands a rysh:// link to the RUNNING app
 * (open-url), but on Linux the desktop entry (Exec=… -- %U) starts a new
 * process with the link in argv, and the app has no single-instance lock by
 * design (instanceManager). So a link launch on Linux, while the primary
 * instance is alive, drops its links into a private inbox the primary reads,
 * and exits without taking a slot. S2.3 makes this the app's single-instance
 * rule for links on every platform that delivers them in argv (Windows too):
 * a link never starts a second app; plain launches still may. The link carries a one-time connect code (a
 * credential): the inbox is this user's 0700 directory of 0600 files, created
 * O_EXCL, never read through a symlink, and each file is removed once read.
 */
/** A link the inbox carries: a connect link, or (rr-order-154 C8, sandboxes flag on) a sandbox desktop link. */
function isForwardable(link: string, sandboxLinks: boolean): boolean {
  return parseConnectLink(link) !== null || (sandboxLinks && parseSandboxDesktopLink(link) !== null)
}

export type LinkLaunchPlan = { kind: 'forward'; links: string[] } | { kind: 'own' }

export function planLinkLaunch(opts: {
  argv: readonly string[]
  platform: NodeJS.Platform
  primaryAlive: boolean
  /** RYSH_EXPERIMENTAL_SANDBOXES=1: sandbox desktop links are forwarded too. */
  sandboxLinks?: boolean
}): LinkLaunchPlan {
  const own: LinkLaunchPlan = { kind: 'own' }
  if (opts.platform === 'darwin' || !opts.primaryAlive) return own
  if (opts.argv.some((a) => a === '--new-instance' || a.startsWith('--instance='))) return own
  const links = opts.argv.filter((a) => a.toLowerCase().startsWith('rysh://') && isForwardable(a, opts.sandboxLinks === true))
  return links.length > 0 ? { kind: 'forward', links } : own
}

function privateDir(dir: string): boolean {
  const st = lstatSync(dir)
  if (!st.isDirectory() || (st.mode & 0o077) !== 0) return false
  return typeof process.getuid !== 'function' || st.uid === process.getuid()
}

/** Writes one 0600 file per link; returns how many were written (0 if the inbox is not private). */
export function writeLinkInbox(dir: string, links: readonly string[]): number {
  let n = 0
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!privateDir(dir)) return 0
    for (const link of links) {
      const p = join(dir, `${Date.now()}-${randomBytes(8).toString('hex')}.link`)
      const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        writeSync(fd, link + '\n')
      } finally {
        closeSync(fd)
      }
      n++
    }
  } catch {
    /* a failed forward falls back to this launch becoming the app (the caller checks the count) */
  }
  return n
}

/**
 * Returns the connect links (and, with sandboxLinks, the sandbox desktop links) waiting in the inbox,
 * oldest first, and removes their files; anything else is dropped.
 */
export function readLinkInbox(dir: string, opts: { sandboxLinks?: boolean } = {}): string[] {
  const out: string[] = []
  try {
    if (!privateDir(dir)) return out
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.link')).sort()) {
      const p = join(dir, name)
      try {
        const st = lstatSync(p)
        if (!st.isFile()) continue // a symlink or anything else: never followed, left alone
        if ((st.mode & 0o077) !== 0) {
          unlinkSync(p) // open to others: dropped unread
          continue
        }
        const fd = openSync(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        let text = ''
        try {
          if (fstatSync(fd).size <= 4096) text = readFileSync(fd, 'utf8').trim()
        } finally {
          closeSync(fd)
        }
        unlinkSync(p)
        if (isForwardable(text, opts.sandboxLinks === true)) out.push(text)
      } catch {
        /* one bad entry never stops the rest */
      }
    }
  } catch {
    /* no inbox yet */
  }
  return out
}
