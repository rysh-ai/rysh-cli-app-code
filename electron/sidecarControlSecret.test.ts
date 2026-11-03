// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

// The desktop app's local connection to its daemon needs a per-launch secret
// (security-lead ruling, class-level). This file checks the sidecar wiring:
// the secret reaches the daemon only through a 0600 handover file named in the
// environment (never argv, never a URL), the app keeps it in its 0600 registry
// to re-adopt a detached daemon, it is never logged, and the renderer never
// sees it. No test prints a secret: values are compared with === only.

const st = vi.hoisted(() => ({
  appData: '',
  home: '',
  spawns: [] as { args: string[]; env: Record<string, string | undefined>; file?: { mode: number; content: string } }[],
  execs: [] as { args: string[]; file?: { mode: number; content: string }; dirMode?: number }[],
  session: null as null | { name: string; pid: number; webPort: number; source: string; webControlSecretFile?: string },
}))

vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => (k === 'home' ? st.home : k === 'appData' ? st.appData : join(st.appData, k)),
    isPackaged: false,
    getAppPath: () => '/nonexistent',
  },
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

function snap(path: string | undefined) {
  if (!path || !existsSync(path)) return undefined
  return { mode: statSync(path).mode & 0o777, content: readFileSync(path, 'utf-8') }
}

vi.mock('child_process', async (orig) => {
  const real = (await orig()) as typeof import('child_process')
  return {
    ...real,
    spawn: vi.fn((_cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
      st.spawns.push({ args, env: opts.env, file: snap(opts.env.RYSH_WEB_CONTROL_SECRET_FILE) })
      const cp = new EventEmitter() as EventEmitter & Record<string, unknown>
      cp.pid = 999_999
      cp.stdout = new EventEmitter()
      cp.stderr = new EventEmitter()
      cp.unref = () => {}
      return cp
    }),
    execFileSync: vi.fn((_cmd: string, args: string[]) => {
      const i = args.indexOf('--control-secret-file')
      const hp = i >= 0 ? args[i + 1] : ''
      st.execs.push({ args, file: hp ? snap(hp) : undefined, dirMode: hp && existsSync(dirname(hp)) ? statSync(dirname(hp)).mode & 0o777 : undefined })
      if (st.session) st.session.webPort = 41299 // the daemon opens its door
      return Buffer.from('')
    }),
  }
})
vi.mock('./sessionStore', () => ({ findSession: () => (st.session ? { ...st.session } : null) }))

import { SidecarManager } from './sidecar'

const SESSION = 'work'
let cwd: string
let logs: string[]

beforeEach(() => {
  st.appData = mkdtempSync(join(tmpdir(), 'ctl-appdata-'))
  st.home = mkdtempSync(join(tmpdir(), 'ctl-home-'))
  cwd = mkdtempSync(join(tmpdir(), 'ctl-ws-'))
  st.spawns = []
  st.execs = []
  st.session = null
  logs = []
  for (const k of ['log', 'error', 'warn', 'info'] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    })
  }
  const P = SidecarManager.prototype as unknown as Record<string, unknown>
  vi.spyOn(P as never, 'killStaleSidecars' as never).mockResolvedValue(undefined as never)
  vi.spyOn(P as never, 'findFreePort' as never).mockResolvedValue(41234 as never)
  vi.spyOn(P as never, 'resolveBinaryPath' as never).mockReturnValue('/nonexistent/rysh' as never)
  vi.spyOn(P as never, 'resolveNatsBroker' as never).mockResolvedValue({ natsPort: null, natsDataDir: null } as never)
  vi.spyOn(P as never, 'waitForHealthy' as never).mockResolvedValue(undefined as never)
  vi.spyOn(P as never, 'probeHealth' as never).mockImplementation((async (port: number) => port > 0) as never)
})
afterEach(() => {
  vi.restoreAllMocks()
})

const secretOf = (m: SidecarManager) => (m as unknown as { getControlSecret(): string | null }).getControlSecret()
const registryFile = () => join(st.appData, 'rysh-cli-app-shared', 'running-daemons.json')
const noLogHas = (s: string) => logs.every((l) => !l.includes(s))

describe('start(): the secret goes to the daemon by a 0600 file, never by argv', () => {
  it('names a 0600 handover file in the env that holds the secret; argv and other env values do not hold it', async () => {
    const m = new SidecarManager(0)
    m.setWorkingDirectory(cwd)
    await m.start()
    const s = secretOf(m)
    expect(typeof s === 'string' && s.length > 0).toBe(true)
    const sp = st.spawns[0]
    expect(sp.args).toEqual(['daemon', 'default'])
    expect(sp.args.every((a) => !a.includes(s!))).toBe(true)
    expect(sp.file?.mode).toBe(0o600)
    expect(sp.file?.content === s + '\n').toBe(true)
    const others = Object.entries(sp.env).filter(([k]) => k !== 'RYSH_WEB_CONTROL_SECRET_FILE')
    expect(others.every(([, v]) => !String(v ?? '').includes(s!))).toBe(true)
    expect(String(sp.env.RYSH_WEB_CONTROL_SECRET_FILE).includes(s!)).toBe(false)
  })

  it('removes the handover file once the daemon answers (backstop for a daemon that did not)', async () => {
    const m = new SidecarManager(0)
    m.setWorkingDirectory(cwd)
    await m.start()
    const p = st.spawns[0]?.env.RYSH_WEB_CONTROL_SECRET_FILE
    expect(typeof p === 'string' && p.length > 0).toBe(true)
    expect(st.spawns[0].file?.mode).toBe(0o600) // it existed at spawn
    expect(existsSync(p!)).toBe(false)
  })

  it('makes a new secret for every launch', async () => {
    const a = new SidecarManager(0)
    a.setWorkingDirectory(cwd)
    await a.start()
    const b = new SidecarManager(0)
    b.setWorkingDirectory(mkdtempSync(join(tmpdir(), 'ctl-ws2-')))
    await b.start()
    expect(secretOf(a) === secretOf(b)).toBe(false)
  })

  it('keeps the secret in the registry, and the registry file is 0600', async () => {
    const m = new SidecarManager(0)
    m.setWorkingDirectory(cwd)
    await m.start()
    const rec = m.getRegistry().find(cwd, 'default') as { controlSecret?: string } | null
    expect(rec?.controlSecret === secretOf(m)).toBe(true)
    expect(statSync(registryFile()).mode & 0o777).toBe(0o600)
  })
})

describe('adopt(): a detached daemon is re-adopted with its stored secret', () => {
  it('uses the secret it is given and keeps it in the registry', async () => {
    const m = new SidecarManager(0)
    m.setWorkingDirectory(cwd)
    const s = (await import('./controlSecret')).makeControlSecret()
    const adopt = m.adopt.bind(m) as (...a: unknown[]) => Promise<boolean>
    expect(await adopt(SESSION, cwd, 41234, process.pid, 'app', s)).toBe(true)
    expect(secretOf(m) === s).toBe(true)
    const rec = m.getRegistry().find(cwd, SESSION) as { controlSecret?: string } | null
    expect(rec?.controlSecret === s).toBe(true)
  })

  it('a record from before the secret existed adopts with no secret (an old daemon needs none)', async () => {
    const m = new SidecarManager(0)
    m.setWorkingDirectory(cwd)
    expect(await m.adopt(SESSION, cwd, 41234, process.pid, 'app')).toBe(true)
    expect(secretOf(m)).toBeNull()
  })
})

describe('ensureWebEndpoint(): opening a door on a live daemon hands the secret over by file', () => {
  it('passes --control-secret-file <0600 file>, never the secret, and returns the secret with the endpoint', async () => {
    st.session = { name: SESSION, pid: process.pid, webPort: 0, source: 'cli' }
    const m = new SidecarManager(0)
    const found = (await m.ensureWebEndpoint(SESSION, cwd)) as { kind: string; port?: number; controlSecret?: string }
    expect(found.kind).toBe('endpoint')
    expect(found.port).toBe(41299)
    const ex = st.execs[0]
    const i = ex.args.indexOf('--control-secret-file')
    expect(i > 0).toBe(true)
    const s = found.controlSecret
    expect(typeof s === 'string' && s.length > 0).toBe(true)
    expect(ex.args.every((a) => !a.includes(s!))).toBe(true)
    expect(ex.file?.mode).toBe(0o600)
    expect(ex.file?.content === s + '\n').toBe(true)
    expect(existsSync(ex.args[i + 1])).toBe(false)
  })
})

describe('the secret is never logged (D3)', () => {
  it('start, adopt and ensureWebEndpoint log nothing that contains it', async () => {
    const m = new SidecarManager(0)
    m.setWorkingDirectory(cwd)
    await m.start()
    const s1 = secretOf(m)!
    st.session = { name: 'other', pid: process.pid, webPort: 0, source: 'cli' }
    const found = (await new SidecarManager(0).ensureWebEndpoint('other', cwd)) as { controlSecret?: string }
    expect(logs.length > 0).toBe(true)
    expect(noLogHas(s1)).toBe(true)
    expect(noLogHas(String(found.controlSecret))).toBe(true)
  })
})

describe('the renderer never holds the secret', () => {
  const root = join(__dirname, '..')
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : [],
    )
  it('no renderer or preload code names the secret, its header or the handover', () => {
    const files = [...walk(join(root, 'src')), join(root, 'electron', 'preload.ts')]
    expect(files.length > 50).toBe(true)
    const hits = files.filter((f) => /controlSecret|ControlSecret|X-Rysh-Control-Secret|CONTROL_SECRET/.test(readFileSync(f, 'utf-8')))
    expect(hits.map((f) => relative(root, f))).toEqual([])
  })
  it('main installs the header on the default session for the app window', () => {
    const main = readFileSync(join(root, 'electron', 'main.ts'), 'utf-8')
    expect(/installControlSecretHeader\(\s*session\.defaultSession/.test(main)).toBe(true)
    expect(/known\.controlSecret/.test(main)).toBe(true)
    expect(/found\.controlSecret/.test(main)).toBe(true)
  })
})

describe('handover path: no whitespace (cli-core: the flag path is typed into a pane)', () => {
  it('the --control-secret-file path has no whitespace even when appData has a space; its 0700 dir is removed after', async () => {
    st.appData = join(mkdtempSync(join(tmpdir(), 'ctl-ws-ad-')), 'Application Support')
    mkdirSync(st.appData)
    st.session = { name: SESSION, pid: process.pid, webPort: 0, source: 'cli' }
    const found = (await new SidecarManager(0).ensureWebEndpoint(SESSION, cwd)) as { kind: string }
    expect(found.kind).toBe('endpoint')
    const ex = st.execs[0]
    const hp = ex.args[ex.args.indexOf('--control-secret-file') + 1]
    expect(typeof hp === 'string' && hp.length > 0).toBe(true)
    expect(/\s/.test(hp)).toBe(false)
    expect(ex.dirMode).toBe(0o700)
    expect(existsSync(dirname(hp))).toBe(false)
  })

  it('start() uses a whitespace-free 0700 temp dir too, removed after the daemon answers', async () => {
    st.appData = join(mkdtempSync(join(tmpdir(), 'ctl-ws-ad2-')), 'Application Support')
    mkdirSync(st.appData)
    const m = new SidecarManager(0)
    m.setWorkingDirectory(cwd)
    await m.start()
    const hp = String(st.spawns[0].env.RYSH_WEB_CONTROL_SECRET_FILE)
    expect(st.spawns[0].file?.mode).toBe(0o600)
    expect(/\s/.test(hp)).toBe(false)
    expect(existsSync(dirname(hp))).toBe(false)
  })

  it('a temp dir with whitespace is refused: no web start runs, and the lookup says why', async () => {
    const before = process.env.TMPDIR
    const spaced = join(mkdtempSync(join(tmpdir(), 'ctl-ws-tmp-')), 'with space')
    mkdirSync(spaced)
    process.env.TMPDIR = spaced
    try {
      st.session = { name: SESSION, pid: process.pid, webPort: 0, source: 'cli' }
      const found = (await new SidecarManager(0).ensureWebEndpoint(SESSION, cwd)) as { kind: string; reason?: string }
      expect(found.kind).toBe('unreachable')
      expect(/whitespace/.test(String(found.reason))).toBe(true)
      expect(st.execs.length).toBe(0)
      expect(readdirSync(spaced)).toEqual([])
    } finally {
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
    }
  })
})

describe("a command-line daemon's own door (O2: record field web_control_secret_file)", () => {
  const putSecret = async (m: number) => {
    const s = (await import('./controlSecret')).makeControlSecret()
    const p = join(mkdtempSync(join(tmpdir(), 'ctl-cli-')), 'web-control.secret')
    writeFileSync(p, s + '\n', { mode: m })
    chmodSync(p, m)
    return { s, p }
  }

  it('an advertised door returns the secret from the 0600 file the record names, and runs no web start', async () => {
    const { s, p } = await putSecret(0o600)
    st.session = { name: SESSION, pid: process.pid, webPort: 41277, source: 'cli', webControlSecretFile: p }
    const found = (await new SidecarManager(0).ensureWebEndpoint(SESSION, cwd)) as { kind: string; controlSecret?: string | null }
    expect(found.kind).toBe('endpoint')
    expect(found.controlSecret === s).toBe(true)
    expect(st.execs.length).toBe(0)
  })

  it('a record file readable by others is not used', async () => {
    const { p } = await putSecret(0o644)
    st.session = { name: SESSION, pid: process.pid, webPort: 41277, source: 'cli', webControlSecretFile: p }
    const found = (await new SidecarManager(0).ensureWebEndpoint(SESSION, cwd)) as { kind: string; controlSecret?: string | null }
    expect(found.kind).toBe('endpoint')
    expect(found.controlSecret ?? null).toBeNull()
  })

  it("adopting a 'cli' daemon prefers the record's current secret over a stored one", async () => {
    const { s, p } = await putSecret(0o600)
    const stale = (await import('./controlSecret')).makeControlSecret()
    st.session = { name: SESSION, pid: process.pid, webPort: 41277, source: 'cli', webControlSecretFile: p }
    const m = new SidecarManager(0)
    m.setWorkingDirectory(cwd)
    expect(await m.adopt(SESSION, cwd, 41277, process.pid, 'cli', stale)).toBe(true)
    expect(secretOf(m) === s).toBe(true)
  })

  it("adopting an 'app' daemon keeps the secret the app made", async () => {
    const { p } = await putSecret(0o600)
    const mine = (await import('./controlSecret')).makeControlSecret()
    st.session = { name: SESSION, pid: process.pid, webPort: 41277, source: 'app', webControlSecretFile: p }
    const m = new SidecarManager(0)
    m.setWorkingDirectory(cwd)
    expect(await m.adopt(SESSION, cwd, 41277, process.pid, 'app', mine)).toBe(true)
    expect(secretOf(m) === mine).toBe(true)
  })
})
