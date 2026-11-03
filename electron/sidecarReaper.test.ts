// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSidecar, processExecutable, reapStaleSidecars, staleCandidates } from './sidecarReaper'

// E12 order 31: killStaleSidecars() stops only a process whose OWN executable
// is the sidecar binary and which leads the process group the app created for
// it (spawn detached). Every process here is started by this test, and every
// one still alive at the end is stopped by its own ChildProcess handle.
//
// The genuine stand-in: the test's sidecar path is a symlink to /bin/sleep, so
// the realpath'd sidecar binary IS the stand-in's executable. (macOS kills a
// renamed copy of a system binary, and the Homebrew node binary does not run
// outside its prefix, so a copy is not used.) The decoy carries the sidecar
// path as argv[0] and as an argument, but its executable is node.

const unix = process.platform === 'darwin' || process.platform === 'linux'

let dir: string
let sidecarPath: string
let started: ChildProcess[] = []
let logs: string[] = []
const log = (s: string): void => {
  logs.push(s)
}

function start(cmd: string, args: string[], opts: { detached?: boolean; argv0?: string } = {}): ChildProcess {
  const c = spawn(cmd, args, { stdio: 'ignore', ...opts })
  started.push(c)
  return c
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e12-o31-'))
  mkdirSync(join(dir, 'sidecar'))
  sidecarPath = join(dir, 'sidecar', `rysh-${process.platform}-${process.arch}`)
  symlinkSync('/bin/sleep', sidecarPath)
  logs = []
})

afterEach(async () => {
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  await settle(50)
  for (const c of started) expect(alive(c.pid!)).toBe(false)
  started = []
  rmSync(dir, { recursive: true, force: true })
})

describe.runIf(unix)('reapStaleSidecars (order 31)', () => {
  it('reads a process executable from the OS, not argv', async () => {
    const decoy = start(process.execPath, ['-e', 'setInterval(()=>{},1e6)', sidecarPath], { argv0: sidecarPath, detached: true })
    await settle(300)
    const exe = processExecutable(decoy.pid!)
    expect(exe).not.toBeNull()
    expect(exe).not.toBe(sidecarPath)
    expect(exe).not.toBe('/bin/sleep')
  })

  it('a genuine stale sidecar (own executable, own group) is stopped', async () => {
    const real = start(sidecarPath, ['60'], { detached: true })
    await settle(300)
    expect(checkSidecar(real.pid!, sidecarPath)).toBe('ours')
    const reaped = await reapStaleSidecars([real.pid!], sidecarPath, { log, graceMs: 2000 })
    expect(reaped).toEqual([real.pid])
    await settle(100)
    expect(alive(real.pid!)).toBe(false)
  })

  it('a decoy with the sidecar path in argv[0] and its arguments is NOT stopped', async () => {
    const decoy = start(process.execPath, ['-e', 'setInterval(()=>{},1e6)', sidecarPath], { argv0: sidecarPath, detached: true })
    await settle(300)
    expect(checkSidecar(decoy.pid!, sidecarPath)).toBe('other-executable')
    const reaped = await reapStaleSidecars([decoy.pid!], sidecarPath, { log, graceMs: 500 })
    expect(reaped).toEqual([])
    await settle(100)
    expect(alive(decoy.pid!)).toBe(true)
    // The log names the pid and the reason, never the command line or a path.
    expect(logs.some((l) => l.includes(String(decoy.pid)))).toBe(true)
    expect(logs.join('\n')).not.toContain(dir)
    expect(logs.join('\n')).not.toContain('setInterval')
  })

  it('a recorded pid whose executable is not the sidecar is skipped and logged by pid', async () => {
    const other = start('/usr/bin/tail', ['-f', '/dev/null'], { detached: true })
    await settle(300)
    const reaped = await reapStaleSidecars([other.pid!], sidecarPath, { log, graceMs: 500 })
    expect(reaped).toEqual([])
    expect(alive(other.pid!)).toBe(true)
    expect(logs).toEqual([`[sidecar] not stopping pid ${other.pid}: other-executable`])
  })

  it('the sidecar executable outside the group the app created is NOT stopped', async () => {
    const shared = start(sidecarPath, ['60']) // not detached: it is in the test's group
    await settle(300)
    expect(checkSidecar(shared.pid!, sidecarPath)).toBe('other-group')
    expect(await reapStaleSidecars([shared.pid!], sidecarPath, { log, graceMs: 500 })).toEqual([])
    expect(alive(shared.pid!)).toBe(true)
  })

  it('a stale pid (already exited) is skipped', async () => {
    const gone = start(sidecarPath, ['0'], { detached: true })
    await new Promise((r) => gone.once('exit', r))
    expect(checkSidecar(gone.pid!, sidecarPath)).toBe('gone')
    expect(await reapStaleSidecars([gone.pid!], sidecarPath, { log, graceMs: 500 })).toEqual([])
  })

  it('this process, and a pid of 0, 1 or below, is never a candidate', async () => {
    expect(checkSidecar(process.pid, sidecarPath)).toBe('invalid')
    for (const p of [0, 1, -1]) expect(checkSidecar(p, sidecarPath)).toBe('invalid')
  })

  it('fails closed when the executable cannot be read (no signal)', async () => {
    const real = start(sidecarPath, ['60'], { detached: true })
    await settle(300)
    // A platform with no identity reader: nothing is read, so nothing is ours.
    expect(checkSidecar(real.pid!, sidecarPath, 'win32')).toBe('unreadable')
    expect(await reapStaleSidecars([real.pid!], sidecarPath, { log, graceMs: 500, platform: 'win32' })).toEqual([])
    expect(alive(real.pid!)).toBe(true)
  })

  it('fails closed when the sidecar binary itself is missing', async () => {
    const real = start('/bin/sleep', ['60'], { detached: true })
    await settle(300)
    expect(checkSidecar(real.pid!, join(dir, 'sidecar', 'absent'))).toBe('no-sidecar')
    expect(alive(real.pid!)).toBe(true)
  })
})

describe('staleCandidates (order 31)', () => {
  it('takes the registry pid of an app daemon and the session pid of an app session', () => {
    expect(staleCandidates({ pid: 101, origin: 'app' }, { pid: 202, source: 'app' }, [])).toEqual([101, 202])
    expect(staleCandidates({ pid: 101 }, null, [])).toEqual([101]) // older records = 'app'
  })
  it('never takes a command-line daemon or a command-line session', () => {
    expect(staleCandidates({ pid: 101, origin: 'cli' }, { pid: 202, source: 'cli' }, [])).toEqual([])
  })
  it('drops duplicates, excluded pids and pids of 1 or below', () => {
    expect(staleCandidates({ pid: 101, origin: 'app' }, { pid: 101, source: 'app' }, [])).toEqual([101])
    expect(staleCandidates({ pid: 101, origin: 'app' }, { pid: 202, source: 'app' }, [202])).toEqual([101])
    expect(staleCandidates({ pid: 1, origin: 'app' }, { pid: 0, source: 'app' }, [])).toEqual([])
  })
})
