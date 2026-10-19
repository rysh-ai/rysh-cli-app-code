// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ handlers: new Map<string, (...a: any[]) => any>(), opened: [] as string[] }))
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, h: (...a: any[]) => any) => state.handlers.set(n, h), removeHandler: (n: string) => state.handlers.delete(n) },
  shell: { openPath: async (p: string) => { state.opened.push(p); return '' } },
}))
import { meetingReportPath, registerMeetingReportHandler } from './meetingReport'

// E-81: the renderer may ask the main process to open one file only — the
// report.md the reporter wrote for that meeting (design 045) — never an
// arbitrary path.

const ID = 'm-3f9a2c'

describe('meetingReportPath', () => {
  it.each([
    ['/Users/ada/p/.rysh/meetings/m-3f9a2c/report.md', ID, true],
    ['/home/ada/.rysh/meetings/m-3f9a2c/report.md', ID, true],
    ['/Users/ada/p/.rysh/meetings/m-000000/report.md', ID, false], // another meeting's report
    ['/Users/ada/p/.rysh/meetings/m-3f9a2c/notes.json', ID, false],
    ['/Users/ada/p/.rysh/meetings/m-3f9a2c/../m-3f9a2c/report.md', ID, false],
    ['/etc/passwd', ID, false],
    ['relative/meetings/m-3f9a2c/report.md', ID, false],
    ['/x/other/m-3f9a2c/report.md', ID, false], // not under a meetings/ dir
    ['/Users/ada/p/.rysh/meetings/m-3f9a2c/report.md', 'm-3f9a2c; rm', false],
    ['', ID, false],
  ])('%s for %s → %s', (path, id, ok) => {
    expect(meetingReportPath(id, path)).toBe(ok ? path : null)
  })

  it('rejects non-strings', () => {
    expect(meetingReportPath(ID as unknown as string, 42 as unknown as string)).toBeNull()
    expect(meetingReportPath(undefined as unknown as string, '/a/meetings/m-3f9a2c/report.md')).toBeNull()
  })
})

describe('meeting-open-report handler', () => {
  const RENDERER = 'file:///app/renderer/index.html'
  let win: any
  let root: string

  beforeEach(() => {
    state.handlers.clear()
    state.opened.length = 0
    const mainFrame = { url: RENDERER }
    win = { isDestroyed: () => false, webContents: { mainFrame }, on: () => {} }
    registerMeetingReportHandler(win, RENDERER)
    root = realpathSync(mkdtempSync(join(tmpdir(), 'e81-')))
  })

  const fromApp = () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  const invoke = (event: unknown, id: unknown, path: unknown) => state.handlers.get('meeting-open-report')!(event, id, path)

  function report(id = ID): string {
    const dir = join(root, '.rysh', 'meetings', id)
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'report.md')
    writeFileSync(p, '# Meeting report\n')
    return p
  }

  it('opens the meeting report the daemon wrote', async () => {
    const p = report()
    expect(await invoke(fromApp(), ID, p)).toEqual({ success: true })
    expect(state.opened).toEqual([p])
  })

  it('refuses a path that is not that meeting report, and opens nothing', async () => {
    const p = report()
    for (const [id, path] of [
      ['m-000000', p],
      [ID, join(root, 'secret.md')],
      [ID, `${root}/.rysh/meetings/${ID}/../${ID}/report.md`], // raw: join() would normalize it
    ]) {
      expect((await invoke(fromApp(), id, path)).success).toBe(false)
    }
    expect(state.opened).toEqual([])
  })

  it('refuses a missing report and a report.md that is a symlink', async () => {
    expect((await invoke(fromApp(), ID, join(root, '.rysh', 'meetings', ID, 'report.md'))).success).toBe(false)
    const target = join(root, 'elsewhere.md')
    writeFileSync(target, 'x')
    const dir = join(root, '.rysh', 'meetings', ID)
    mkdirSync(dir, { recursive: true })
    symlinkSync(target, join(dir, 'report.md'))
    expect((await invoke(fromApp(), ID, join(dir, 'report.md'))).success).toBe(false)
    expect(state.opened).toEqual([])
  })

  it('answers only the app window main frame', async () => {
    const p = report()
    const webPane = { sender: { id: 'web-pane' }, senderFrame: { url: 'https://evil.example' } }
    await expect(invoke(webPane, ID, p)).rejects.toThrow()
    const navigated = { sender: win.webContents, senderFrame: { url: 'https://evil.example' } }
    await expect(invoke(navigated, ID, p)).rejects.toThrow()
    expect(state.opened).toEqual([])
  })
})
