// @vitest-environment node
//
// S2.3 (sprint 0.2.16, design 037 + plan v4 R4): the company page offers a small
// connect file, rysh-connect-<slug>.ryshconnect, as the fallback when the browser
// does not hand the rysh://connect link to the app. Format agreed 2026-11-08 with
// founder-tools (S2.2 server) and cli-core (S2.5 `ry connect --file`):
//   {"rysh_connect":1,"server":"<origin>","code":"rysh_ct_<48 hex>",
//    "company":{"name":"…","slug":"…"},"expires_at":"<RFC3339 UTC>"}
// It holds a one-time code (a credential) and never a key. On first launch the
// app picks up the newest such file from Downloads/Desktop that is at most 30
// minutes old, asks ONE question naming the server and the company, claims it,
// and deletes the file only after a good claim.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECT_FILE_MAX_AGE_MS,
  claimConnectFile,
  connectFileDirs,
  connectFilePrompt,
  findConnectFile,
  isFirstLaunchForPickup,
  markPickupDone,
  parseConnectFile,
  pickUpConnectFile,
} from './connectFile'

const CODE = 'rysh_ct_' + 'a'.repeat(48)
const NOW = Date.parse('2026-11-09T10:00:00Z')
const LATER = '2026-11-09T10:25:00Z'

function body(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    rysh_connect: 1,
    server: 'https://rysh.ai',
    code: CODE,
    company: { name: 'Acme Widgets Ltd', slug: 'acme-widgets' },
    expires_at: LATER,
    ...over,
  })
}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 's23-'))
  dirs.push(d)
  return d
}
/** Writes a 0600 file with the given mtime (ms since epoch). */
function put(dir: string, name: string, text: string, mtimeMs: number): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, text, { mode: 0o600 })
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
  return p
}

describe('parseConnectFile (the agreed format)', () => {
  it('a good file -> the server + code to claim, and the company for the prompt', () => {
    const r = parseConnectFile(body(), NOW)
    expect(r).toEqual({
      ok: true,
      target: { server: 'https://rysh.ai', token: CODE },
      company: { name: 'Acme Widgets Ltd', slug: 'acme-widgets' },
    })
  })
  it('a loopback http server is accepted (a local server); the server confirm still applies later', () => {
    expect(parseConnectFile(body({ server: 'http://127.0.0.1:8080' }), NOW).ok).toBe(true)
  })
  it.each([
    ['not JSON', 'rysh://connect?server=x'],
    ['an array', '[]'],
    ['version 2', body({ rysh_connect: 2 })],
    ['no version', JSON.stringify({ server: 'https://rysh.ai', code: CODE, company: { name: 'a', slug: 'a' }, expires_at: LATER })],
    ['a code of the wrong shape', body({ code: 'rysh_ct_' + 'A'.repeat(48) })],
    ['a short code', body({ code: 'rysh_ct_abc' })],
    ['plain http off loopback', body({ server: 'http://rysh.ai' })],
    ['a server with a path', body({ server: 'https://rysh.ai/x' })],
    ['a server with a user', body({ server: 'https://u:p@rysh.ai' })],
    ['a server with a query', body({ server: 'https://rysh.ai?a=1' })],
    ['a non-http server', body({ server: 'file:///etc/passwd' })],
    ['no company name', body({ company: { slug: 'a' } })],
    ['an expired code', body({ expires_at: '2026-11-09T09:59:59Z' })],
    ['an unreadable expiry', body({ expires_at: 'soon' })],
  ])('refuses %s', (_what, text) => {
    const r = parseConnectFile(text, NOW)
    expect(r.ok).toBe(false)
  })
  it('refuses an unknown top-level field (the file is exactly the agreed shape)', () => {
    expect(parseConnectFile(body({ note: 'hi' }), NOW).ok).toBe(false)
  })
  it.each(['api_key', 'key', 'secret', 'token', 'API_KEY'])('refuses a field named %s anywhere, even nested', (name) => {
    expect(parseConnectFile(body({ company: { name: 'a', slug: 'a', [name]: 'x' } }), NOW).ok).toBe(false)
  })
  it('refuses any rysh_ string other than the code (workspace keys are rysh_ + random; cli-core 11-08)', () => {
    expect(parseConnectFile(body({ company: { name: 'rysh_Q2xk9PzA7hLmN3', slug: 'acme' } }), NOW).ok).toBe(false)
    expect(parseConnectFile(body({ company: { name: 'Acme', slug: 'rysh_abc' } }), NOW).ok).toBe(false)
  })
  it('the refusal never repeats the code', () => {
    const r = parseConnectFile(body({ server: 'http://evil.example' }), NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).not.toContain(CODE)
  })
  it('a file over 4 KB is refused', () => {
    expect(parseConnectFile(body({ company: { name: 'x'.repeat(5000), slug: 'a' } }), NOW).ok).toBe(false)
  })
})

describe('connectFileDirs', () => {
  it('Downloads then Desktop under the home directory', () => {
    expect(connectFileDirs('/home/u')).toEqual([join('/home/u', 'Downloads'), join('/home/u', 'Desktop')])
  })
})

describe('findConnectFile (newest *.ryshconnect, at most 30 minutes old)', () => {
  it('picks the newest across Downloads and Desktop', () => {
    const home = scratch()
    const [dl, desk] = connectFileDirs(home)
    put(dl, 'rysh-connect-a.ryshconnect', body(), NOW - 10 * 60_000)
    const newest = put(desk, 'rysh-connect-b.ryshconnect', body(), NOW - 2 * 60_000)
    expect(findConnectFile(connectFileDirs(home), NOW)).toBe(newest)
  })
  it('a stale file (older than 30 minutes) is ignored', () => {
    const home = scratch()
    put(connectFileDirs(home)[0], 'rysh-connect-a.ryshconnect', body(), NOW - CONNECT_FILE_MAX_AGE_MS - 1000)
    expect(findConnectFile(connectFileDirs(home), NOW)).toBeNull()
  })
  it('CONNECT_FILE_MAX_AGE_MS is 30 minutes (the code lifetime)', () => {
    expect(CONNECT_FILE_MAX_AGE_MS).toBe(30 * 60_000)
  })
  it('a file dated in the future is ignored', () => {
    const home = scratch()
    put(connectFileDirs(home)[0], 'rysh-connect-a.ryshconnect', body(), NOW + 10 * 60_000)
    expect(findConnectFile(connectFileDirs(home), NOW)).toBeNull()
  })
  it('a normal browser download (0644: readable by others, written only by this user) IS picked up', () => {
    const home = scratch()
    const p = put(connectFileDirs(home)[0], 'rysh-connect-a.ryshconnect', body(), NOW - 60_000)
    chmodSync(p, 0o644)
    expect(findConnectFile(connectFileDirs(home), NOW)).toBe(p)
  })
  it('readConnectFile (a file the user chose) accepts a 0644 download too', async () => {
    const home = scratch()
    const p = put(home, 'rysh-connect-a.ryshconnect', body(), NOW - 60_000)
    chmodSync(p, 0o644)
    const out = await claimConnectFile(p, { now: NOW, ask: async () => true, claim: async () => ({ success: true }) })
    expect(out).toEqual({ kind: 'claimed', path: p })
  })
  it('other extensions, symlinks and files others may write are ignored', () => {
    const home = scratch()
    const [dl] = connectFileDirs(home)
    put(dl, 'rysh-connect-a.json', body(), NOW - 60_000)
    const target = put(home, 'elsewhere.ryshconnect', body(), NOW - 60_000)
    symlinkSync(target, join(dl, 'link.ryshconnect'))
    const open = put(dl, 'open.ryshconnect', body(), NOW - 60_000)
    chmodSync(open, 0o666)
    const groupWritable = put(dl, 'group.ryshconnect', body(), NOW - 60_000)
    chmodSync(groupWritable, 0o664)
    utimesSync(groupWritable, (NOW - 60_000) / 1000, (NOW - 60_000) / 1000)
    utimesSync(open, (NOW - 60_000) / 1000, (NOW - 60_000) / 1000)
    expect(findConnectFile(connectFileDirs(home), NOW)).toBeNull()
  })
  it('missing folders are fine', () => {
    expect(findConnectFile([join(scratch(), 'nope')], NOW)).toBeNull()
  })
})

describe('connectFilePrompt', () => {
  it('names the company and the server host, never the code', () => {
    const p = connectFilePrompt({ name: 'Acme Widgets Ltd', slug: 'acme-widgets' }, 'https://rysh.ai')
    expect(p.message).toContain('Acme Widgets Ltd')
    expect(p.message + p.detail).toContain('rysh.ai')
    expect(p.message + p.detail).not.toContain('rysh_ct_')
  })
})

describe('claimConnectFile / pickUpConnectFile', () => {
  function setup(mtime = NOW - 60_000, text = body()) {
    const home = scratch()
    const p = put(connectFileDirs(home)[0], 'rysh-connect-acme-widgets.ryshconnect', text, mtime)
    return { home, p }
  }

  it('one prompt, then the claim; the file is deleted after a good claim', async () => {
    const { home, p } = setup()
    const ask = vi.fn(async () => true)
    const claim = vi.fn(async () => ({ success: true }))
    const out = await pickUpConnectFile({ dirs: connectFileDirs(home), now: NOW, ask, claim })
    expect(out).toEqual({ kind: 'claimed', path: p })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(claim).toHaveBeenCalledWith({ server: 'https://rysh.ai', token: CODE })
    expect(existsSync(p)).toBe(false)
  })
  it('a failed claim keeps the file (and says why)', async () => {
    const { home, p } = setup()
    const out = await pickUpConnectFile({
      dirs: connectFileDirs(home),
      now: NOW,
      ask: async () => true,
      claim: async () => ({ success: false, error: 'connect code is invalid, expired or already used' }),
    })
    expect(out).toEqual({ kind: 'failed', path: p, error: 'connect code is invalid, expired or already used' })
    expect(existsSync(p)).toBe(true)
  })
  it('a claim that throws keeps the file', async () => {
    const { home, p } = setup()
    const out = await pickUpConnectFile({ dirs: connectFileDirs(home), now: NOW, ask: async () => true, claim: async () => { throw new Error('boom') } })
    expect(out.kind).toBe('failed')
    expect(existsSync(p)).toBe(true)
  })
  it('the user says no -> nothing is claimed and the file stays', async () => {
    const { home, p } = setup()
    const claim = vi.fn(async () => ({ success: true }))
    const out = await pickUpConnectFile({ dirs: connectFileDirs(home), now: NOW, ask: async () => false, claim })
    expect(out).toEqual({ kind: 'declined', path: p })
    expect(claim).not.toHaveBeenCalled()
    expect(existsSync(p)).toBe(true)
  })
  it('a file already declined this run is not asked again', async () => {
    const { home, p } = setup()
    const ask = vi.fn(async () => true)
    const out = await pickUpConnectFile({ dirs: connectFileDirs(home), now: NOW, ask, claim: async () => ({ success: true }), skip: new Set([p]) })
    expect(out).toEqual({ kind: 'none' })
    expect(ask).not.toHaveBeenCalled()
  })
  it('a stale file is ignored: no prompt, no claim, file untouched', async () => {
    const { home, p } = setup(NOW - CONNECT_FILE_MAX_AGE_MS - 1000)
    const ask = vi.fn(async () => true)
    const claim = vi.fn(async () => ({ success: true }))
    expect(await pickUpConnectFile({ dirs: connectFileDirs(home), now: NOW, ask, claim })).toEqual({ kind: 'none' })
    expect(ask).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
    expect(existsSync(p)).toBe(true)
  })
  it('a key-bearing file is refused before any prompt, and left for the user', async () => {
    const { home, p } = setup(NOW - 60_000, body({ company: { name: 'a', slug: 'a', api_key: 'rysh_x' } }))
    const ask = vi.fn(async () => true)
    const out = await pickUpConnectFile({ dirs: connectFileDirs(home), now: NOW, ask, claim: async () => ({ success: true }) })
    expect(out.kind).toBe('refused')
    expect(ask).not.toHaveBeenCalled()
    expect(existsSync(p)).toBe(true)
  })
  it('claimConnectFile (the file the user chose) refuses a symlink', async () => {
    const home = scratch()
    const target = put(home, 'real.ryshconnect', body(), NOW - 60_000)
    const link = join(home, 'link.ryshconnect')
    symlinkSync(target, link)
    const out = await claimConnectFile(link, { now: NOW, ask: async () => true, claim: async () => ({ success: true }) })
    expect(out.kind).toBe('refused')
    expect(existsSync(target)).toBe(true)
  })
  it('claimConnectFile accepts an explicitly chosen file older than 30 minutes while its code is unexpired', async () => {
    const { p } = setup(NOW - 40 * 60_000)
    const out = await claimConnectFile(p, { now: NOW, ask: async () => true, claim: async () => ({ success: true }) })
    expect(out).toEqual({ kind: 'claimed', path: p })
  })
})

describe('first launch only (macOS asks the user before any app lists Downloads or Desktop)', () => {
  it('no marker and no workspace ever opened -> first launch', () => {
    expect(isFirstLaunchForPickup(join(scratch(), 'connect-file-pickup.done'), 0)).toBe(true)
  })
  it('a workspace was opened before (an existing user, e.g. after an update) -> not first launch', () => {
    expect(isFirstLaunchForPickup(join(scratch(), 'connect-file-pickup.done'), 1)).toBe(false)
  })
  it('markPickupDone writes the marker (0600); after it, never again', () => {
    const marker = join(scratch(), 'connect-file-pickup.done')
    markPickupDone(marker)
    expect(lstatSync(marker).mode & 0o777).toBe(0o600)
    expect(isFirstLaunchForPickup(marker, 0)).toBe(false)
  })
  it('the mac build explains the Downloads and Desktop prompts (Info.plist usage strings)', () => {
    const yml = readFileSync(resolve(__dirname, '../electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/^\s+NSDownloadsFolderUsageDescription: .*connect file/m)
    expect(yml).toMatch(/^\s+NSDesktopFolderUsageDescription: .*connect file/m)
  })
})

describe('wiring (static)', () => {
  const main = readFileSync(resolve(__dirname, 'main.ts'), 'utf8')
  it('the recent-workspace count is read before the boot plan can add the default workspace', () => {
    const count = main.indexOf('const recentAtStart = workspaceManager.getRecent().length')
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(main.indexOf('const bootPlan = planBoot('))
  })
  it('S2.4: a fresh connect file on first launch counts as a pending link, so boot skips the default workspace', () => {
    const plan = main.indexOf('const bootPlan = planBoot(')
    const first = main.indexOf('const firstLaunchFile =')
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(plan)
    expect(main.slice(first, plan)).toMatch(/isFirstLaunchForPickup\(pickupMarker, recentAtStart\)/)
    expect(main.slice(first, plan)).toMatch(/findConnectFile\(connectFileDirs\(app\.getPath\('home'\)\), Date\.now\(\)\)/)
    expect(main).toMatch(/pendingConnectLinks: pendingConnectLinks\.length \+ \(firstLaunchFile \? 1 : 0\)/)
  })
  it('the pickup runs only on first launch and marks it done', () => {
    const ready = main.indexOf('appReadyForConnect = true')
    const pick = main.indexOf('pickUpConnectFile(')
    expect(main.slice(ready, pick)).toMatch(/isFirstLaunchForPickup\(pickupMarker, recentAtStart\)/)
    expect(main.slice(ready, pick)).toMatch(/markPickupDone\(pickupMarker\)/)
  })
  it('only the primary picks up a connect file, once the app can open a workspace', () => {
    const ready = main.indexOf('appReadyForConnect = true')
    const pick = main.indexOf('pickUpConnectFile(')
    expect(ready).toBeGreaterThan(0)
    expect(pick).toBeGreaterThan(ready)
    expect(main.slice(ready, pick)).toMatch(/instance\.isPrimary/)
  })
  it('the claim goes through handleConnectLink (server confirm, --vehicle desktop, result checks)', () => {
    expect(main).toMatch(/claim: \(target\) => handleConnectTarget\(target\)/)
  })
  it('a chosen file arrives over its own IPC channel and uses claimConnectFile', () => {
    // ipc.ts holds every handler (registerIpcHandlers); main supplies the callback.
    const ipc = readFileSync(resolve(__dirname, 'ipc.ts'), 'utf8')
    expect(ipc).toMatch(/ipcMain\.handle\('connect-company-file', async \(\) =>/)
    expect(main).toMatch(/onConnectCompanyFile: \(\) => chooseConnectFile\(\)/)
    expect(main).toMatch(/extensions: \['ryshconnect'\]/)
    expect(main).toMatch(/claimConnectFile\(/)
  })
})
