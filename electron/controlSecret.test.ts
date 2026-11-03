// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTROL_SECRET_HEADER,
  controlHeaderFor,
  installControlSecretHeader,
  makeControlSecret,
  readSecretFile,
  removeHandoverFile,
  writeHandoverFile,
  type ControlTarget,
} from './controlSecret'

// The desktop app's local connection to its daemon needs a per-launch secret
// (security-lead ruling, class-level). The app's main process makes it, hands it
// to the daemon through a 0600 file (never argv, never a URL), and attaches it as
// a header only to the app window's own requests to that daemon. The renderer
// never holds it. No test prints a secret.

const mode = (p: string) => statSync(p).mode & 0o777
const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `ctl-${tag}-`))

describe('makeControlSecret', () => {
  it('is at least 32 random bytes, base64url, new on every call', () => {
    const a = makeControlSecret()
    const b = makeControlSecret()
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true)
    expect(Buffer.from(a, 'base64url').length >= 32).toBe(true)
    expect(a === b).toBe(false)
  })
})

describe('handover file', () => {
  it('is mode 0600 in a 0700 dir, holds the secret on one line, and its path does not contain the secret', () => {
    const dir = join(tmp('ho'), 'control')
    const s = makeControlSecret()
    const p = writeHandoverFile(dir, s)
    expect(mode(dir)).toBe(0o700)
    expect(mode(p)).toBe(0o600)
    expect(readFileSync(p, 'utf-8') === s + '\n').toBe(true)
    expect(p.includes(s)).toBe(false)
  })

  it('tightens an existing, looser dir to 0700', () => {
    const dir = join(tmp('ho2'), 'control')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    writeHandoverFile(dir, makeControlSecret())
    expect(mode(dir)).toBe(0o700)
  })

  it('two daemons get two different files', () => {
    const dir = join(tmp('ho3'), 'control')
    expect(writeHandoverFile(dir, makeControlSecret())).not.toBe(writeHandoverFile(dir, makeControlSecret()))
  })

  it('removeHandoverFile deletes it, and is quiet when the daemon already did', () => {
    const p = writeHandoverFile(join(tmp('ho4'), 'control'), makeControlSecret())
    removeHandoverFile(p)
    expect(existsSync(p)).toBe(false)
    expect(() => removeHandoverFile(p)).not.toThrow()
  })
})

describe('readSecretFile (a secret the daemon made for a command-line door)', () => {
  const put = (content: string, m = 0o600) => {
    const p = join(tmp('rs'), 'secret')
    writeFileSync(p, content, { mode: m })
    chmodSync(p, m)
    return p
  }

  it('reads a 0600 one-line file', () => {
    const s = makeControlSecret()
    expect(readSecretFile(put(s + '\n')) === s).toBe(true)
  })
  it('refuses a file with group or other bits', () => {
    expect(readSecretFile(put(makeControlSecret() + '\n', 0o640))).toBeNull()
    expect(readSecretFile(put(makeControlSecret() + '\n', 0o604))).toBeNull()
  })
  it('refuses a symlink', () => {
    const real = put(makeControlSecret() + '\n')
    const link = join(tmp('rsl'), 'link')
    symlinkSync(real, link)
    expect(readSecretFile(link)).toBeNull()
  })
  it('refuses a secret shorter than 32 bytes, or more than one line', () => {
    expect(readSecretFile(put(Buffer.alloc(16, 1).toString('base64url') + '\n'))).toBeNull()
    expect(readSecretFile(put(makeControlSecret() + '\n' + makeControlSecret() + '\n'))).toBeNull()
  })
  it('refuses a missing file or an empty path', () => {
    expect(readSecretFile(join(tmp('rsm'), 'none'))).toBeNull()
    expect(readSecretFile('')).toBeNull()
  })
})

describe('controlHeaderFor: only the app window, only its daemon', () => {
  const secret = makeControlSecret()
  const t: ControlTarget = { webContentsId: 7, port: 41234, secret }

  it('the app window to ws://127.0.0.1:<port> and http://127.0.0.1:<port> gets the secret', () => {
    expect(controlHeaderFor('ws://127.0.0.1:41234/ws?stream=1', 7, t) === secret).toBe(true)
    expect(controlHeaderFor('http://127.0.0.1:41234/api/env', 7, t) === secret).toBe(true)
  })
  it('another webContents (the session picker, anything else on this session) gets nothing', () => {
    expect(controlHeaderFor('ws://127.0.0.1:41234/ws', 8, t)).toBeNull()
    expect(controlHeaderFor('ws://127.0.0.1:41234/ws', undefined, t)).toBeNull()
    expect(controlHeaderFor('ws://127.0.0.1:41234/ws', -1, t)).toBeNull()
  })
  it('another port gets nothing', () => {
    expect(controlHeaderFor('ws://127.0.0.1:41235/ws', 7, t)).toBeNull()
    expect(controlHeaderFor('http://127.0.0.1/ws', 7, t)).toBeNull()
  })
  it('other hosts and schemes get nothing (one host, not localhost too)', () => {
    for (const u of [
      'ws://localhost:41234/ws',
      'ws://[::1]:41234/ws',
      'wss://127.0.0.1:41234/ws',
      'https://127.0.0.1:41234/',
      'http://127.0.0.2:41234/',
      'http://evil.invalid:41234/',
      'http://127.0.0.1:41234@evil.invalid/',
      'file:///tmp/x',
      'not a url',
    ]) {
      expect(controlHeaderFor(u, 7, t)).toBeNull()
    }
  })
  it('no target, or a target with no secret, gets nothing', () => {
    expect(controlHeaderFor('ws://127.0.0.1:41234/ws', 7, null)).toBeNull()
    expect(controlHeaderFor('ws://127.0.0.1:41234/ws', 7, { ...t, secret: '' })).toBeNull()
    expect(controlHeaderFor('ws://127.0.0.1:41234/ws', 7, { ...t, port: 0 })).toBeNull()
  })
})

describe('installControlSecretHeader', () => {
  type Details = { url: string; webContentsId?: number; requestHeaders: Record<string, string> }
  type Listener = (d: Details, cb: (r: { requestHeaders: Record<string, string> }) => void) => void
  function fakeSession() {
    let listener: Listener | null = null
    let calls = 0
    const ses = {
      webRequest: {
        onBeforeSendHeaders: (l: Listener) => {
          calls++
          listener = l
        },
      },
    }
    const send = (d: Details) =>
      new Promise<Record<string, string>>((resolve) => listener!(d, (r) => resolve(r.requestHeaders)))
    return { ses, send, calls: () => calls }
  }

  it('adds the header to the target request and leaves every other request as it was', async () => {
    const secret = makeControlSecret()
    const f = fakeSession()
    installControlSecretHeader(f.ses, () => ({ webContentsId: 7, port: 41234, secret }))
    expect(f.calls()).toBe(1)
    const hit = await f.send({ url: 'ws://127.0.0.1:41234/ws', webContentsId: 7, requestHeaders: { A: '1' } })
    expect(hit[CONTROL_SECRET_HEADER] === secret).toBe(true)
    expect(hit.A).toBe('1')
    const miss = await f.send({ url: 'ws://127.0.0.1:41234/ws', webContentsId: 9, requestHeaders: { A: '1' } })
    expect(miss).toEqual({ A: '1' })
  })

  it('reads the target on every request (a workspace switch changes the port and the secret)', async () => {
    let target: ControlTarget | null = null
    const f = fakeSession()
    installControlSecretHeader(f.ses, () => target)
    expect(Object.keys(await f.send({ url: 'ws://127.0.0.1:41234/ws', webContentsId: 7, requestHeaders: {} }))).toEqual([])
    const s2 = makeControlSecret()
    target = { webContentsId: 7, port: 50000, secret: s2 }
    const h = await f.send({ url: 'ws://127.0.0.1:50000/ws', webContentsId: 7, requestHeaders: {} })
    expect(h[CONTROL_SECRET_HEADER] === s2).toBe(true)
  })

  it('drops a same-named header that a page set on a request that is not the target', async () => {
    const f = fakeSession()
    installControlSecretHeader(f.ses, () => ({ webContentsId: 7, port: 41234, secret: makeControlSecret() }))
    const h = await f.send({
      url: 'http://127.0.0.1:41235/',
      webContentsId: 7,
      requestHeaders: { [CONTROL_SECRET_HEADER.toLowerCase()]: 'x', B: '2' },
    })
    expect(h).toEqual({ B: '2' })
  })
})
