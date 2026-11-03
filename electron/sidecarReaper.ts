import { execFileSync } from 'child_process'
import { readFileSync, readlinkSync, realpathSync } from 'fs'

/**
 * Stopping a stale sidecar daemon safely (E12 order 31).
 *
 * The candidates come only from the app's own records — the daemon registry and
 * the session record (see staleCandidates) — never from matching a pattern
 * against the process table. Even then a recorded pid may since have exited and
 * been reused by an unrelated process, so before any signal each one must pass
 * the identity check (checkSidecar):
 *
 *   - it is alive, and this process may signal it;
 *   - its OWN executable, as the OS reports it, is the sidecar binary (both
 *     realpath'd). argv is never consulted: argv[0] is whatever the starter
 *     chose, so it proves nothing;
 *   - it leads its own process group, which is what the app created for it
 *     (SidecarManager spawns the daemon with detached: true).
 *
 * Anything else is "not ours": it is left alone and only its pid and the reason
 * are logged, never its command line. A reader that fails (no lsof output, an
 * unreadable /proc, an unsupported platform) fails closed: no signal.
 */

/** A read-only system tool, by absolute path: never resolved from PATH. */
const LSOF = '/usr/sbin/lsof'

/**
 * macOS: one `lsof -a -p <pid> -d txt -F pgn` read gives the process group (the
 * `g` line) and the executable (the first `n` line). null when it fails.
 */
function lsofIdentity(pid: number): { exe: string | null; pgid: number | null } | null {
  try {
    const out = execFileSync(LSOF, ['-a', '-p', String(pid), '-d', 'txt', '-F', 'pgn'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const lines = out.split('\n')
    const n = lines.find((l) => l.startsWith('n'))
    const g = parseInt(lines.find((l) => l.startsWith('g'))?.slice(1) ?? '', 10)
    return { exe: n ? n.slice(1) : null, pgid: g > 0 ? g : null }
  } catch {
    return null
  }
}

export type SidecarVerdict =
  | 'ours'
  | 'invalid' // pid <= 1, or this process
  | 'gone' // no such process
  | 'not-permitted' // alive, but not ours to signal
  | 'unreadable' // its executable or group could not be read: fail closed
  | 'no-sidecar' // the sidecar binary itself does not resolve
  | 'other-executable'
  | 'other-group'

/**
 * The executable of `pid` as the OS process table records it: on macOS the
 * first `n` line of lsof's txt entries, on Linux /proc/<pid>/exe.
 * null when it cannot be read, or on any other platform.
 */
export function processExecutable(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === 'linux') return readlinkSync(`/proc/${pid}/exe`)
    if (platform === 'darwin') return lsofIdentity(pid)?.exe ?? null
  } catch {
    /* gone, unreadable, or the reader failed */
  }
  return null
}

/** The process group of `pid`, or null when it cannot be read. */
export function processGroup(pid: number, platform: NodeJS.Platform = process.platform): number | null {
  try {
    if (platform === 'linux') {
      // /proc/<pid>/stat: "pid (comm) state ppid pgrp ..."; comm may hold spaces.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const pg = parseInt(fields[2], 10)
      return pg > 0 ? pg : null
    }
    if (platform === 'darwin') return lsofIdentity(pid)?.pgid ?? null
  } catch {
    /* gone or unreadable */
  }
  return null
}

function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** The identity check: is `pid` a sidecar daemon the app started? */
export function checkSidecar(
  pid: number,
  sidecarPath: string,
  platform: NodeJS.Platform = process.platform
): SidecarVerdict {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return 'invalid'
  try {
    process.kill(pid, 0)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'not-permitted' : 'gone'
  }
  let want: string
  try {
    want = realpathSync(sidecarPath)
  } catch {
    return 'no-sidecar'
  }
  const exe = processExecutable(pid, platform)
  if (exe === null) return 'unreadable'
  if (canonical(exe) !== want) return 'other-executable'
  const pg = processGroup(pid, platform)
  if (pg === null) return 'unreadable'
  if (pg !== pid) return 'other-group'
  return 'ours'
}

/**
 * The pids that may hold a stale daemon for the session about to start: the
 * registry's pid when the app started that daemon (origin 'app'; absent on older
 * records, which were all 'app'), and the session record's pid when the app
 * created the session. Command-line daemons are never the app's to stop.
 */
export function staleCandidates(
  registry: { pid: number; origin?: string } | null,
  session: { pid: number; source: string } | null,
  exclude: number[]
): number[] {
  const out: number[] = []
  if (registry && (registry.origin ?? 'app') === 'app') out.push(registry.pid)
  if (session && session.source === 'app') out.push(session.pid)
  return [...new Set(out)].filter((p) => Number.isInteger(p) && p > 1 && !exclude.includes(p))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Stop each candidate that passes the identity check: SIGTERM, wait up to
 * graceMs, then SIGKILL — re-checking the identity first, so a pid that exited
 * and was reused during the wait is never signalled. Returns the pids stopped.
 */
export async function reapStaleSidecars(
  pids: number[],
  sidecarPath: string,
  opts: { graceMs?: number; log?: (line: string) => void; platform?: NodeJS.Platform } = {}
): Promise<number[]> {
  const graceMs = opts.graceMs ?? 3000
  const log = opts.log ?? ((line: string) => console.log(line))
  const platform = opts.platform ?? process.platform
  const reaped: number[] = []
  for (const pid of [...new Set(pids)]) {
    const verdict = checkSidecar(pid, sidecarPath, platform)
    if (verdict !== 'ours') {
      if (verdict !== 'gone' && verdict !== 'invalid') log(`[sidecar] not stopping pid ${pid}: ${verdict}`)
      continue
    }
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      continue // exited in between
    }
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline && checkSidecar(pid, sidecarPath, platform) === 'ours') await sleep(100)
    if (checkSidecar(pid, sidecarPath, platform) === 'ours') {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* exited in between */
      }
    }
    reaped.push(pid)
  }
  return reaped
}
