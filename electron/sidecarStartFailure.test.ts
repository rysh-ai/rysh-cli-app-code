// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// When the daemon exits before it ever answers (a refused start: for example D-55 B, where
// another project already holds this project's bus port), the app used to wait the full 30 s
// health timeout, restart the daemon three times into the same refusal, and then show only
// "health check timed out". start() must instead fail at once with the daemon's own last
// stderr line, and not restart a start that never came up. A daemon that was running and then
// crashed is still restarted, as before.

const st = vi.hoisted(() => ({
  appData: '',
  home: '',
  children: [] as (EventEmitter & Record<string, unknown>)[],
}))

vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => (k === 'home' ? st.home : k === 'appData' ? st.appData : join(st.appData, k)),
    isPackaged: false,
    getAppPath: () => '/nonexistent',
  },
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('child_process', async (orig) => {
  const real = (await orig()) as typeof import('child_process')
  return {
    ...real,
    spawn: vi.fn(() => {
      const cp = new EventEmitter() as EventEmitter & Record<string, unknown>
      cp.pid = 990_000 + st.children.length
      cp.stdout = new EventEmitter()
      cp.stderr = new EventEmitter()
      cp.unref = () => {}
      st.children.push(cp)
      return cp
    }),
  }
})

import { SidecarManager } from './sidecar'

let healthy: { resolve: () => void } | null
beforeEach(() => {
  st.appData = mkdtempSync(join(tmpdir(), 'sfail-appdata-'))
  st.home = mkdtempSync(join(tmpdir(), 'sfail-home-'))
  st.children = []
  healthy = null
  for (const k of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, k).mockImplementation(() => {})
  const P = SidecarManager.prototype as unknown as Record<string, unknown>
  vi.spyOn(P as never, 'killStaleSidecars' as never).mockResolvedValue(undefined as never)
  vi.spyOn(P as never, 'findFreePort' as never).mockResolvedValue(41234 as never)
  vi.spyOn(P as never, 'resolveBinaryPath' as never).mockReturnValue('/nonexistent/rysh' as never)
  vi.spyOn(P as never, 'resolveNatsBroker' as never).mockResolvedValue({ natsPort: null, natsDataDir: null } as never)
  vi.spyOn(P as never, 'reportCrash' as never).mockImplementation((() => {}) as never)
  // The daemon's /health: pending until the test says it answered.
  vi.spyOn(P as never, 'waitForHealthy' as never).mockImplementation(
    (() => new Promise<void>((resolve) => { healthy = { resolve } })) as never,
  )
})
afterEach(() => {
  vi.restoreAllMocks()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
const REFUSAL =
  'rysh: start nats bus: nats port 24300 is already served by session "other" of another project; stop the other daemon, or give this project another nats.port'

describe('a daemon that exits before it answers', () => {
  it('fails start() at once with its last stderr line', async () => {
    const m = new SidecarManager(0)
    m.setWorkingDirectory(mkdtempSync(join(tmpdir(), 'sfail-ws-')))
    const started = m.start()
    await tick(20)
    const cp = st.children[0]
    ;(cp.stderr as EventEmitter).emit('data', Buffer.from('some startup line\n' + REFUSAL + '\n'))
    cp.emit('exit', 1, null)
    const t0 = Date.now()
    const err = await started.then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(Date.now() - t0 < 1000).toBe(true)
    expect(String(err?.message)).toContain('exited (code 1) before it answered')
    expect(String(err?.message)).toContain(REFUSAL)
  })

  it('is not restarted into the same refusal', async () => {
    const m = new SidecarManager(0)
    m.setWorkingDirectory(mkdtempSync(join(tmpdir(), 'sfail-ws2-')))
    const started = m.start().catch(() => {})
    await tick(20)
    st.children[0].emit('exit', 1, null)
    await started
    await tick(1300) // the first auto-restart would come after 1 s
    expect(st.children.length).toBe(1)
  })

  it('says so plainly when it printed nothing', async () => {
    const m = new SidecarManager(0)
    m.setWorkingDirectory(mkdtempSync(join(tmpdir(), 'sfail-ws3-')))
    const started = m.start()
    await tick(20)
    st.children[0].emit('exit', null, 'SIGKILL')
    const err = await started.then(() => null, (e: Error) => e)
    expect(String(err?.message)).toContain('exited (signal SIGKILL) before it answered')
  })
})

describe('a daemon that was running and then crashed', () => {
  it('is still restarted, as before', async () => {
    const m = new SidecarManager(0)
    m.setWorkingDirectory(mkdtempSync(join(tmpdir(), 'sfail-ws4-')))
    const started = m.start()
    await tick(20)
    healthy!.resolve()
    await started
    st.children[0].emit('exit', 2, null)
    await tick(1300)
    expect(st.children.length).toBe(2)
  })
})
