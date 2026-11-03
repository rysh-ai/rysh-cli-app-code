// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync as realWrite } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// security-lead LEAD-PASS condition C1 (class-level): the daemon registry holds
// each daemon's connection secret, so no write may ever leave the secret in a
// file that group or other can read, not even for a moment. An old registry
// from before the secret (default mode 0644) must end 0600, and the shared dir
// must be 0700. Secrets are compared with includes() only; nothing is printed.

const st = vi.hoisted(() => ({
  appData: '',
  // For every write whose data holds a secret: the file's mode right after it.
  secretWrites: [] as { mode: number }[],
  secret: '',
}))

vi.mock('electron', () => ({
  app: { getPath: (k: string) => (k === 'appData' ? st.appData : join(st.appData, k)) },
}))

vi.mock('fs', async (orig) => {
  const real = (await orig()) as typeof import('fs')
  const writeFileSync = ((path: string, data: string, opts?: unknown) => {
    real.writeFileSync(path, data, opts as never)
    if (st.secret && String(data).includes(st.secret)) {
      st.secretWrites.push({ mode: real.statSync(path).mode & 0o777 })
    }
  }) as typeof real.writeFileSync
  return { ...real, default: { ...real, writeFileSync }, writeFileSync }
})

import { DaemonRegistry, SHARED_DIR_NAME } from './daemonRegistry'
import { makeControlSecret } from './controlSecret'

const shared = () => join(st.appData, SHARED_DIR_NAME)
const regFile = () => join(shared(), 'running-daemons.json')
const mode = (p: string) => statSync(p).mode & 0o777

beforeEach(() => {
  st.appData = mkdtempSync(join(tmpdir(), 'reg-mode-'))
  st.secretWrites = []
  st.secret = makeControlSecret()
})

function rec(secret?: string) {
  return {
    sessionName: 'work',
    cwd: '/w',
    pid: 4242,
    webPort: 41234,
    updatedAt: 'x',
    ...(secret ? { controlSecret: secret } : {}),
  }
}

describe('registry file mode (C1)', () => {
  it('an old 0644 registry ends 0600, and the secret is never in a file others can read', () => {
    mkdirSync(shared(), { recursive: true })
    realWrite(regFile(), JSON.stringify([rec()]), { mode: 0o644 })
    chmodSync(regFile(), 0o644)
    const r = new DaemonRegistry(0)
    r.record(rec(st.secret))
    expect(mode(regFile())).toBe(0o600)
    expect(st.secretWrites.length > 0).toBe(true)
    expect(st.secretWrites.every((w) => w.mode === 0o600)).toBe(true)
    expect(r.find('/w', 'work')?.controlSecret === st.secret).toBe(true)
  })

  it('a new registry is 0600 from its first write', () => {
    const r = new DaemonRegistry(0)
    r.record(rec(st.secret))
    expect(mode(regFile())).toBe(0o600)
    expect(st.secretWrites.length > 0).toBe(true)
    expect(st.secretWrites.every((w) => w.mode === 0o600)).toBe(true)
  })

  it('the shared dir is 0700, also when it existed looser', () => {
    mkdirSync(shared(), { recursive: true, mode: 0o755 })
    chmodSync(shared(), 0o755)
    new DaemonRegistry(0).record(rec(st.secret))
    expect(mode(shared())).toBe(0o700)
  })

  it('leaves no temp file behind', () => {
    const r = new DaemonRegistry(0)
    r.record(rec(st.secret))
    r.record({ ...rec(st.secret), webPort: 41235 })
    expect(readdirSync(shared()).filter((n) => n !== 'running-daemons.json')).toEqual([])
  })
})
