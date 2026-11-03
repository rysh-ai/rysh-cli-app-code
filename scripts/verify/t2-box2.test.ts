// @vitest-environment node
//
// BOX 2 of the Linux desktop smoke (scripts/verify/e12-t2-linux-smoke.sh): "first launch
// with no ~/.config/rysh reaches a usable state". The verdict is a bash function in
// lib-t2-box2.sh; these cases run it directly, without launching the app.
//
// Since E-90 (founder ruling R8, faad2e7) a first run creates ~/rysh-workspace (under the
// fresh HOME the box sets up) and opens it, so the first-run state is that workspace, not
// the old "No workspace loaded" welcome screen. The H-33 dev-host run 3 (2026-11-01) showed
// exactly that on both the .deb and the AppImage, and the old check called it FAILED.
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'

const LIB = resolve(__dirname, 'lib-t2-box2.sh')

function verdict(alive: string, rt: string, home: string): { rc: number | null; out: string } {
  const r = spawnSync('bash', ['-c', '. "$0"; t2_box2_verdict "$1" "$2" "$3"', LIB, alive, rt, home], { encoding: 'utf8' })
  return { rc: r.status, out: r.stdout.trim() }
}

// The renderer text (CDP) from H-33 run 3, .deb leg (deploy evidence 2026-11-01), as the box prints it.
const RUN3_RT = [
  'target: Rysh | file:///opt/Rysh/resources/app.asar/dist/renderer/index.html',
  'innerText: "ws:\\nrysh-workspace\\ntab-1\\n+\\n▦\\n▤\\nFaceTime\\nMeeting\\n⇶\\n⟳\\n⏻\\n⏏\\nAG\\nHU\\nSH\\nShell\\nidle"',
].join('\n')
const WELCOME_RT = [
  'target: Rysh | file:///opt/Rysh/resources/app.asar/dist/renderer/index.html',
  'innerText: "No workspace loaded. Open a project directory containing a .rysh folder.\\nOpen Workspace…"',
].join('\n')
const OTHER_WS_RT = RUN3_RT.replace('ws:\\nrysh-workspace', 'ws:\\nsomeproject')

const homes: string[] = []
function freshHome(withDefaultWorkspace: boolean): string {
  const h = mkdtempSync(join(tmpdir(), 't2-box2-'))
  homes.push(h)
  if (withDefaultWorkspace) mkdirSync(join(h, 'rysh-workspace'))
  return h
}
afterEach(() => { while (homes.length) rmSync(homes.pop() as string, { recursive: true, force: true }) })

describe('t2_box2_verdict (E-90 first run)', () => {
  it('run 3: alive, renderer shows the default workspace, ~/rysh-workspace created under the fresh HOME -> CHECKED', () => {
    const r = verdict('1', RUN3_RT, freshHome(true))
    expect(r.out).toMatch(/^CHECKED /)
    expect(r.rc).toBe(0)
  })

  it('the old welcome screen on a first run means E-90 did not happen -> FAILED', () => {
    const r = verdict('1', WELCOME_RT, freshHome(false))
    expect(r.out).toMatch(/^FAILED /)
    expect(r.rc).toBe(1)
  })

  it('process dead -> FAILED, whatever the renderer showed', () => {
    const r = verdict('0', RUN3_RT, freshHome(true))
    expect(r.out).toMatch(/^FAILED alive=0/)
    expect(r.rc).toBe(1)
  })

  it('renderer shows rysh-workspace but it was not created under the fresh HOME -> FAILED (profile not proven fresh)', () => {
    const r = verdict('1', RUN3_RT, freshHome(false))
    expect(r.out).toMatch(/^FAILED /)
    expect(r.rc).toBe(1)
  })

  it('another workspace opened on a "first" launch -> FAILED (a reopened profile, not a first run)', () => {
    const r = verdict('1', OTHER_WS_RT, freshHome(true))
    expect(r.out).toMatch(/^FAILED /)
    expect(r.rc).toBe(1)
  })
})
