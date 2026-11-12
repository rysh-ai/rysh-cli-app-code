// @vitest-environment node
//
// CD4 (sprint 0.2.16, design 037 on Linux). The .deb's desktop entry already
// declares MimeType=x-scheme-handler/rysh with Exec=… -- %U (checked in the
// rehearsal 9c .deb). What Linux lacks: macOS hands a rysh:// link to the
// RUNNING app (open-url), but on Linux the OS starts a new process with the link
// in argv, and the app has no single-instance lock by design (instanceManager),
// so every clicked link while Rysh runs would start a whole new instance (own
// slot, NATS port, daemon). The fix: a launch whose argv holds rysh:// links,
// on Linux, while the primary instance is alive, drops the links into a private
// inbox the primary reads, and exits. The link carries a one-time code (a
// credential), so the inbox is this user's 0700 dir of 0600 files, never read
// through a symlink.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { planLinkLaunch, readLinkInbox, writeLinkInbox } from './linkLaunch'

const LINK = 'rysh://connect?server=https%3A%2F%2Frysh.ai&token=rysh_ct_' + 'a'.repeat(48)

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'cd4-'))
  dirs.push(d)
  return d
}

describe('planLinkLaunch', () => {
  const base = { platform: 'linux' as NodeJS.Platform, primaryAlive: true }
  it('Linux, argv holds a rysh:// link, primary alive -> forward the link, take no slot', () => {
    expect(planLinkLaunch({ ...base, argv: ['/opt/Rysh/rysh-desktop', '--', LINK] })).toEqual({ kind: 'forward', links: [LINK] })
  })
  it('no primary alive -> this launch becomes the app as today', () => {
    expect(planLinkLaunch({ ...base, primaryAlive: false, argv: ['x', '--', LINK] }).kind).toBe('own')
  })
  it('S2.3 single instance for links: Windows delivers links in argv too -> the same forward to the running app', () => {
    expect(planLinkLaunch({ ...base, platform: 'win32', argv: ['C:\\Rysh\\Rysh.exe', LINK] })).toEqual({ kind: 'forward', links: [LINK] })
  })
  it('macOS -> own (open-url already reaches the running app)', () => {
    expect(planLinkLaunch({ ...base, platform: 'darwin', argv: ['x', LINK] }).kind).toBe('own')
  })
  it('no link -> own (a plain launch still allocates a new instance, a feature)', () => {
    expect(planLinkLaunch({ ...base, argv: ['x', '--'] }).kind).toBe('own')
  })
  it('an explicit --new-instance or --instance=N -> own', () => {
    expect(planLinkLaunch({ ...base, argv: ['x', '--new-instance', LINK] }).kind).toBe('own')
    expect(planLinkLaunch({ ...base, argv: ['x', '--instance=2', LINK] }).kind).toBe('own')
  })
  it('only rysh://connect links are forwarded; anything else in argv is ignored', () => {
    const p = planLinkLaunch({ ...base, argv: ['x', '--', 'rysh://open?x=1', LINK, 'https://evil.example'] })
    expect(p).toEqual({ kind: 'forward', links: [LINK] })
  })
})

describe('the link inbox', () => {
  it('write: a 0700 dir, one 0600 file per link; read: returns the link and removes the file', () => {
    const inbox = join(scratch(), 'connect-inbox')
    expect(writeLinkInbox(inbox, [LINK])).toBe(1)
    expect(lstatSync(inbox).mode & 0o777).toBe(0o700)
    const files = readdirSync(inbox)
    expect(files).toHaveLength(1)
    expect(lstatSync(join(inbox, files[0])).mode & 0o777).toBe(0o600)
    expect(readLinkInbox(inbox)).toEqual([LINK])
    expect(readdirSync(inbox)).toHaveLength(0)
  })
  it('read: a symlink in the inbox is not followed (its target stays unread and in place)', () => {
    const base = scratch()
    const inbox = join(base, 'connect-inbox')
    mkdirSync(inbox, { mode: 0o700 })
    writeFileSync(join(base, 'target'), LINK + '\n', { mode: 0o600 })
    symlinkSync(join(base, 'target'), join(inbox, 'x.link'))
    expect(readLinkInbox(inbox)).toEqual([])
    expect(readFileSync(join(base, 'target'), 'utf8')).toBe(LINK + '\n')
  })
  it('read: a file open to others (0644) or that is not a connect link is dropped, never returned', () => {
    const inbox = join(scratch(), 'connect-inbox')
    mkdirSync(inbox, { mode: 0o700 })
    writeFileSync(join(inbox, 'a.link'), LINK + '\n', { mode: 0o644 })
    chmodSync(join(inbox, 'a.link'), 0o644)
    writeFileSync(join(inbox, 'b.link'), 'https://evil.example\n', { mode: 0o600 })
    expect(readLinkInbox(inbox)).toEqual([])
  })
  it('read: an inbox dir open to others is refused (nothing returned)', () => {
    const inbox = join(scratch(), 'connect-inbox')
    mkdirSync(inbox, { mode: 0o755 })
    chmodSync(inbox, 0o755)
    writeFileSync(join(inbox, 'a.link'), LINK + '\n', { mode: 0o600 })
    expect(readLinkInbox(inbox)).toEqual([])
  })
})

describe('packaging pins (the parts that already work on Linux)', () => {
  // Text checks (no YAML library in the main tsconfig); scripts/verify/linux-packaging-config.test.ts parses it.
  const yml = readFileSync(resolve(__dirname, '../electron-builder.yml'), 'utf8')
  it('protocols registers the rysh scheme (-> MimeType=x-scheme-handler/rysh in the .deb desktop entry)', () => {
    expect(yml).toMatch(/^protocols:\n(?:\s+.*\n)*?\s+schemes:\n\s+- rysh$/m)
  })
  it('linux.executableArgs stays ["--"] (Exec=… -- %U: a link is never read as a Chromium switch)', () => {
    expect(yml).toMatch(/^\s+executableArgs: \["--"\]$/m)
  })
})

describe('wiring (static)', () => {
  const main = readFileSync(resolve(__dirname, 'main.ts'), 'utf8')
  const im = readFileSync(resolve(__dirname, 'instanceManager.ts'), 'utf8')
  it('main.ts plans a link launch BEFORE allocateInstance() takes a slot, and exits after a full forward', () => {
    const plan = main.indexOf('planLinkLaunch(')
    const alloc = main.indexOf('allocateInstance()')
    expect(plan).toBeGreaterThan(0)
    expect(alloc).toBeGreaterThan(plan)
    expect(main.slice(plan, alloc)).toMatch(/writeLinkInbox\(linkInboxDir\(\), linkPlan\.links\) === linkPlan\.links\.length/)
    expect(main.slice(plan, alloc)).toMatch(/process\.exit\(0\)/)
  })
  it('S2.3: every argv-link platform (not macOS) checks the primary and forwards; only the primary reads the inbox', () => {
    expect(main).toMatch(/primaryAlive: process\.platform !== 'darwin' && isPrimaryAlive\(\)/)
    expect(main).toMatch(/instance\.isPrimary && process\.platform !== 'darwin'/)
    // rr-order-154 C8 (boat-web): one read of the inbox; sandbox desktop links go to the sandbox window,
    // everything else (connect links) to the connect queue as before.
    expect(main).toMatch(/for \(const l of readLinkInbox\(linkInboxDir\(\), \{ sandboxLinks: sandboxLinkLaunch \}\)\) \{\n\s+if \(isSandboxDesktopLinkArg\(l\)\) void app\.whenReady\(\)\.then\(\(\) => handleSandboxDesktopLink\(l\)\)\n\s+else pendingConnectLinks\.push\(l\)/)
  })
  it('instanceManager exports isPrimaryAlive() and linkInboxDir() under the shared dir', () => {
    expect(im).toMatch(/export function isPrimaryAlive\(\): boolean/)
    expect(im).toMatch(/export function linkInboxDir\(\): string/)
    expect(im).toMatch(/join\(app\.getPath\('appData'\), SHARED_DIR_NAME, 'connect-inbox'\)/)
  })
})

// rr-order-154 C8 (boat-web): a rysh://sandbox-desktop link follows the same S2.3 rule (a link never
// starts a second app) — but only with RYSH_EXPERIMENTAL_SANDBOXES=1. With the flag off nothing
// changes: the launch plan and the inbox ignore sandbox links exactly as before.
describe('sandbox desktop links (rr-order-154 C8, dark)', () => {
  const base = { platform: 'linux' as NodeJS.Platform, primaryAlive: true }
  const SBX = 'rysh://sandbox-desktop?server=https%3A%2F%2Frysh.ai&workspace=ws_1&sandbox=sbx_1&mode=watch'
  it('flag on: a sandbox desktop link is forwarded to the running app', () => {
    expect(planLinkLaunch({ ...base, sandboxLinks: true, argv: ['x', '--', SBX] })).toEqual({ kind: 'forward', links: [SBX] })
  })
  it('flag off (or not given): a sandbox desktop link is not forwarded, as before', () => {
    expect(planLinkLaunch({ ...base, sandboxLinks: false, argv: ['x', '--', SBX] }).kind).toBe('own')
    expect(planLinkLaunch({ ...base, argv: ['x', '--', SBX] }).kind).toBe('own')
  })
  it('flag on: a sandbox link that carries a ticket or token is never forwarded', () => {
    expect(planLinkLaunch({ ...base, sandboxLinks: true, argv: ['x', '--', SBX + '&ticket=abc'] }).kind).toBe('own')
    expect(planLinkLaunch({ ...base, sandboxLinks: true, argv: ['x', '--', SBX + '&token=abc'] }).kind).toBe('own')
  })
  it('flag on: connect and sandbox links together are forwarded in argv order; macOS still owns', () => {
    expect(planLinkLaunch({ ...base, sandboxLinks: true, argv: ['x', '--', SBX, LINK] })).toEqual({ kind: 'forward', links: [SBX, LINK] })
    expect(planLinkLaunch({ ...base, platform: 'darwin', sandboxLinks: true, argv: ['x', SBX] }).kind).toBe('own')
  })
  it('inbox, flag on: a sandbox link is returned (and its file removed) next to connect links', () => {
    const inbox = join(scratch(), 'connect-inbox')
    expect(writeLinkInbox(inbox, [SBX, LINK])).toBe(2)
    expect(readLinkInbox(inbox, { sandboxLinks: true }).sort()).toEqual([LINK, SBX].sort())
    expect(readdirSync(inbox)).toHaveLength(0)
  })
  it('inbox, flag off: a sandbox link is dropped unread, as any non-connect link', () => {
    const inbox = join(scratch(), 'connect-inbox')
    expect(writeLinkInbox(inbox, [SBX])).toBe(1)
    expect(readLinkInbox(inbox)).toEqual([])
    expect(readdirSync(inbox)).toHaveLength(0)
  })
  it('inbox, flag on: a sandbox link with a credential param is dropped', () => {
    const inbox = join(scratch(), 'connect-inbox')
    expect(writeLinkInbox(inbox, [SBX + '&key=abc'])).toBe(1)
    expect(readLinkInbox(inbox, { sandboxLinks: true })).toEqual([])
  })
  it('wiring (static): main.ts reads the flag once and passes it to the launch plan', () => {
    const main = readFileSync(resolve(__dirname, 'main.ts'), 'utf8')
    const flag = main.indexOf('const sandboxLinkLaunch = sandboxesEnabled(process.env)')
    const plan = main.indexOf('planLinkLaunch(')
    expect(flag).toBeGreaterThan(0)
    expect(plan).toBeGreaterThan(flag)
    expect(main).toMatch(/primaryAlive: process\.platform !== 'darwin' && isPrimaryAlive\(\), sandboxLinks: sandboxLinkLaunch \}\)/)
  })
})
