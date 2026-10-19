// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs = vi.hoisted(() => ({ appData: '', home: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => (k === 'home' ? dirs.home : k === 'appData' ? dirs.appData : join(dirs.appData, k)),
    isPackaged: false,
    getAppPath: () => '/nonexistent',
  },
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { SidecarManager } from './sidecar'
import { DaemonRegistry, isPidAlive } from './daemonRegistry'

// E-77, founder ruling R18: Quit leaves an adopted, CLI-started daemon
// running (Detach behaviour). The app stops only daemons it spawned.

/** A stand-in daemon: a separate process answering /health on a free port. */
function fakeDaemon(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const s=require('http').createServer((q,r)=>{r.writeHead(200);r.end('ok')});` +
        `s.listen(0,'127.0.0.1',()=>console.log(s.address().port));setInterval(()=>{},1e6)`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', (b) => resolve({ child, port: Number(String(b).trim()) }))
    child.once('error', reject)
  })
}

const SESSION = 'work'
let cwd: string
let daemons: ChildProcess[] = []

beforeEach(() => {
  dirs.appData = mkdtempSync(join(tmpdir(), 'e77-appdata-'))
  dirs.home = mkdtempSync(join(tmpdir(), 'e77-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'e77-ws-'))
})
afterEach(() => {
  for (const d of daemons) d.kill('SIGKILL')
  daemons = []
})

async function adopted(origin: 'app' | 'cli') {
  const d = await fakeDaemon()
  daemons.push(d.child)
  const m = new SidecarManager(0)
  m.setWorkingDirectory(cwd)
  expect(await m.adopt(SESSION, cwd, d.port, d.child.pid!, origin)).toBe(true)
  return { m, pid: d.child.pid!, port: d.port }
}

describe('Quit (SidecarManager.shutdown)', () => {
  it('leaves an adopted CLI-started daemon running, recorded like a Detach', async () => {
    const { m, pid, port } = await adopted('cli')
    await m.shutdown()
    expect(isPidAlive(pid)).toBe(true)
    expect(m.getPid()).toBe(0)
    expect(m.isRunning()).toBe(false)
    // The next launch re-adopts it from the registry, and still knows it is not ours.
    const rec = new DaemonRegistry(0).findAlive(cwd, SESSION)
    expect(rec).toMatchObject({ pid, webPort: port, origin: 'cli' })
  }, 15000)

  it('a re-adopted CLI daemon is still released on the next Quit', async () => {
    const { m, pid, port } = await adopted('cli')
    await m.shutdown()
    const next = new SidecarManager(0)
    next.setWorkingDirectory(cwd)
    const rec = next.getRegistry().findAlive(cwd, SESSION)!
    expect(await next.adopt(SESSION, cwd, port, pid, rec.origin)).toBe(true)
    await next.shutdown()
    expect(isPidAlive(pid)).toBe(true)
  }, 15000)

  it('still stops an adopted daemon the app itself spawned in an earlier run', async () => {
    const { m, pid } = await adopted('app')
    await m.shutdown()
    await vi.waitFor(() => expect(isPidAlive(pid)).toBe(false), { timeout: 6000 })
    expect(new DaemonRegistry(0).find(cwd, SESSION)).toBeNull()
  }, 15000)

  it('still stops a daemon this run spawned', async () => {
    const d = await fakeDaemon()
    daemons.push(d.child)
    const m = new SidecarManager(0)
    m.setWorkingDirectory(cwd)
    ;(m as unknown as { process: ChildProcess }).process = d.child // as start() leaves it
    await m.shutdown()
    await vi.waitFor(() => expect(isPidAlive(d.child.pid!)).toBe(false), { timeout: 6000 })
  }, 15000)

  it('an explicit stop() still stops a CLI daemon (Restart daemon is a deliberate user action)', async () => {
    const { m, pid } = await adopted('cli')
    await m.stop()
    await vi.waitFor(() => expect(isPidAlive(pid)).toBe(false), { timeout: 6000 })
  }, 15000)
})
