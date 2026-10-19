// @vitest-environment node
//
// Decision tests for resources/linux/launcher.sh (E-94/E-95): the launcher in
// front of the Linux Electron binary that refuses — with exit 78 and a message —
// to start an AppImage where Chromium's sandbox cannot work, and otherwise
// execs the real binary with its arguments untouched.
//
// Each case builds a throwaway "app dir" (launcher + stub rysh-desktop.bin +
// chrome-sandbox) and runs the launcher under /bin/sh with a PATH it controls
// completely, so every input to the decision is injected rather than read from
// the machine running the tests:
//
//   APPIMAGE                        set / unset
//   RYSH_USERNS_RESTRICT_SYSCTL     a temp file holding "1" or "0"
//   chrome-sandbox                  mode 0755 / 4755, owner via a stub `stat`
//   argv                            with / without --no-sandbox, before / after --
//   unshare                         stub exiting 0 / 1, or absent
//   zenity / kdialog / notify-send  stubs on PATH, or absent
import { spawnSync } from 'child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

const LAUNCHER = resolve(__dirname, '../../resources/linux/launcher.sh')
const EX_SANDBOX_UNAVAILABLE = 78

interface Case {
  appimage?: boolean // $APPIMAGE set (default true)
  restricted?: '1' | '0' | null // sysctl file content; null = file missing (default '1')
  setuidRoot?: boolean // chrome-sandbox 4755 and stat reports uid 0 (default false)
  setuidBitOnly?: boolean // 4755 but owned by a normal user
  unshare?: 'fail' | 'ok' | 'absent' // probe outcome (default 'fail')
  dialogs?: Array<'zenity' | 'kdialog' | 'notify-send'>
  skipEnv?: boolean // RYSH_SKIP_SANDBOX_CHECK=1
  args?: string[]
}

interface Result {
  status: number | null
  stderr: string
  stdout: string
  argv: string[] | null // what rysh-desktop.bin received, or null if it never ran
  dialogCalls: string[]
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function stub(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

function run(c: Case = {}): Result {
  const root = mkdtempSync(join(tmpdir(), 'rysh-launcher-'))
  dirs.push(root)
  const app = join(root, 'app')
  const bin = join(root, 'bin')
  for (const d of [app, bin]) spawnSync('mkdir', ['-p', d])

  // The app dir, laid out as afterPack leaves it.
  copyFileSync(LAUNCHER, join(app, 'rysh-desktop'))
  chmodSync(join(app, 'rysh-desktop'), 0o755)
  const argvFile = join(root, 'argv')
  stub(join(app, 'rysh-desktop.bin'), `: > "${argvFile}"; for a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done; echo REAL-BINARY-RAN`)
  writeFileSync(join(app, 'chrome-sandbox'), '')
  chmodSync(join(app, 'chrome-sandbox'), c.setuidRoot || c.setuidBitOnly ? 0o4755 : 0o755)

  // PATH: only what the launcher needs, plus the stubs this case asks for.
  for (const tool of ['dirname', 'readlink', 'cat']) {
    const real = spawnSync('/bin/sh', ['-c', `command -v ${tool}`]).stdout.toString().trim()
    symlinkSync(real, join(bin, tool))
  }
  // `stat -c %u <file>` -> the owner uid; GNU syntax, so stubbed (macOS stat has no -c).
  stub(join(bin, 'stat'), `echo ${c.setuidRoot ? 0 : 1000}`)
  const unshare = c.unshare ?? 'fail'
  if (unshare !== 'absent') stub(join(bin, 'unshare'), `exit ${unshare === 'ok' ? 0 : 1}`)
  const dialogLog = join(root, 'dialogs')
  for (const d of c.dialogs ?? []) stub(join(bin, d), `echo "${d} LD_LIBRARY_PATH=[$LD_LIBRARY_PATH] $*" >> "${dialogLog}"`)

  const sysctl = join(root, 'apparmor_restrict_unprivileged_userns')
  const restricted = c.restricted === undefined ? '1' : c.restricted
  if (restricted !== null) writeFileSync(sysctl, `${restricted}\n`)

  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: root,
    RYSH_USERNS_RESTRICT_SYSCTL: sysctl,
    LD_LIBRARY_PATH: '/appdir/usr/lib', // what AppRun exports; dialogs must not inherit it
  }
  if (c.appimage ?? true) env.APPIMAGE = join(root, 'Rysh-test.AppImage')
  if (c.skipEnv) env.RYSH_SKIP_SANDBOX_CHECK = '1'

  const r = spawnSync('/bin/sh', [join(app, 'rysh-desktop'), ...(c.args ?? [])], { env, encoding: 'utf8' })
  return {
    status: r.status,
    stderr: r.stderr,
    stdout: r.stdout,
    argv: existsSync(argvFile) ? readFileSync(argvFile, 'utf8').split('\n').slice(0, -1) : null,
    // One entry per dialog invocation: the message spans lines, so keep only
    // the lines a stub starts with its own name.
    dialogCalls: existsSync(dialogLog)
      ? readFileSync(dialogLog, 'utf8').split('\n').filter((l) => /^(zenity|kdialog|notify-send) LD_LIBRARY_PATH=/.test(l))
      : [],
  }
}

function expectBlocked(r: Result): void {
  expect(r.status).toBe(EX_SANDBOX_UNAVAILABLE)
  expect(r.argv).toBeNull()
  expect(r.stderr).toContain('Rysh cannot start from this AppImage on this system.')
  expect(r.stderr).toContain('Please install the .deb package from https://rysh.ai/download instead.')
  expect(r.stderr).toContain('exiting with status 78 (sandbox unavailable)')
}

function expectPassthrough(r: Result, args: string[] = []): void {
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('REAL-BINARY-RAN')
  expect(r.argv).toEqual(args)
  expect(r.stderr).not.toContain('Rysh cannot start')
}

describe('launcher.sh — blocks only when every condition holds', () => {
  it('blocks: AppImage + restricted + no setuid root + no --no-sandbox + probe fails', () => {
    expectBlocked(run())
  })

  it('blocks when unshare is not installed (the probe cannot vouch for namespaces)', () => {
    expectBlocked(run({ unshare: 'absent' }))
  })

  it('blocks with the desktop entry args (-- %U expanded to a link)', () => {
    expectBlocked(run({ args: ['--', 'rysh://connect?code=x'] }))
  })
})

describe('launcher.sh — each condition flipped steps aside', () => {
  it('not an AppImage ($APPIMAGE unset, i.e. the .deb) -> passthrough', () => {
    expectPassthrough(run({ appimage: false }))
  })

  it('sysctl reads 0 -> passthrough', () => {
    expectPassthrough(run({ restricted: '0' }))
  })

  it('sysctl file missing (older kernel) -> passthrough', () => {
    expectPassthrough(run({ restricted: null }))
  })

  it('chrome-sandbox setuid root -> passthrough', () => {
    expectPassthrough(run({ setuidRoot: true }))
  })

  it('setuid bit without root ownership does NOT count -> still blocks', () => {
    expectBlocked(run({ setuidBitOnly: true }))
  })

  it('user passed --no-sandbox before -- -> passthrough, the flag is forwarded untouched', () => {
    expectPassthrough(run({ args: ['--no-sandbox'] }), ['--no-sandbox'])
  })

  it('unshare probe succeeds (e.g. user installed a profile) -> passthrough', () => {
    expectPassthrough(run({ unshare: 'ok' }))
  })

  it('RYSH_SKIP_SANDBOX_CHECK=1 -> passthrough, and it does not add --no-sandbox', () => {
    expectPassthrough(run({ skipEnv: true }))
  })
})

describe('launcher.sh — Chromium switch semantics around --', () => {
  it('--no-sandbox AFTER -- is a positional arg, not a switch -> still blocks', () => {
    expectBlocked(run({ args: ['--', '--no-sandbox'] }))
  })

  it('passthrough keeps argv exactly, -- included, in order', () => {
    const args = ['--no-sandbox', '--', 'rysh://connect?code=a b', '--looks-like-a-flag', '']
    expectPassthrough(run({ args }), args)
  })

  it('passthrough with the desktop-entry shape on a non-AppImage install', () => {
    expectPassthrough(run({ appimage: false, args: ['--', 'rysh://x'] }), ['--', 'rysh://x'])
  })
})

describe('launcher.sh — how the refusal is shown', () => {
  it('no dialog tool on PATH -> stderr only, says so', () => {
    const r = run()
    expectBlocked(r)
    expect(r.stderr).toContain('dialog: none available (stderr only)')
    expect(r.dialogCalls).toEqual([])
  })

  it('zenity preferred over kdialog and notify-send, and run without the AppImage LD_LIBRARY_PATH', () => {
    const r = run({ dialogs: ['zenity', 'kdialog', 'notify-send'] })
    expectBlocked(r)
    expect(r.stderr).toContain('dialog: zenity')
    expect(r.dialogCalls).toHaveLength(1)
    expect(r.dialogCalls[0]).toMatch(/^zenity LD_LIBRARY_PATH=\[\] --error/)
  })

  it('kdialog when zenity is absent', () => {
    const r = run({ dialogs: ['kdialog', 'notify-send'] })
    expectBlocked(r)
    expect(r.stderr).toContain('dialog: kdialog')
    expect(r.dialogCalls).toHaveLength(1)
    expect(r.dialogCalls[0]).toMatch(/^kdialog LD_LIBRARY_PATH=\[\] /)
  })

  it('notify-send as the last resort', () => {
    const r = run({ dialogs: ['notify-send'] })
    expectBlocked(r)
    expect(r.stderr).toContain('dialog: notify-send')
    expect(r.dialogCalls[0]).toMatch(/^notify-send LD_LIBRARY_PATH=\[\] --urgency=critical/)
  })
})
