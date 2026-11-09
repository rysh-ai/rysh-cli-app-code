// @vitest-environment node
//
// L8 (sprint 0.2.16, desktop): two update dead ends seen in the macOS VM runs.
// R8b-2 (11-05): an app macOS runs translocated (a read-only random path under
// /private/var/folders/…/AppTranslocation/, e.g. started without moving it out
// of Downloads, or straight from the mounted dmg under /Volumes) cannot be
// replaced by Squirrel: "Restart Now" hung with a spinning cursor and no word.
// R8b finding 1 (11-04): a Standard user with Rysh in root-owned /Applications
// is asked for an administrator's name and password at install, unannounced.
// updateLocation reads where the app runs from and says which case applies.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { appBundleOf, updateLocation } from './updateLocation'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop() as string
    try { chmodSync(d, 0o755) } catch { /* gone */ }
    rmSync(d, { recursive: true, force: true })
  }
})
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'l8-'))
  dirs.push(d)
  return d
}

describe('appBundleOf', () => {
  it('the .app bundle that holds the executable', () => {
    expect(appBundleOf('/Applications/Rysh.app/Contents/MacOS/Rysh')).toBe('/Applications/Rysh.app')
    expect(appBundleOf('/Users/u/Applications/Rysh.app/Contents/MacOS/Rysh')).toBe('/Users/u/Applications/Rysh.app')
  })
  it('null when not inside a bundle (dev runs, Linux)', () => {
    expect(appBundleOf('/usr/local/bin/electron')).toBeNull()
  })
})

describe('updateLocation', () => {
  it('translocated -> cannot update; tells the user to move Rysh to Applications', () => {
    const r = updateLocation('/private/var/folders/x1/abc/T/AppTranslocation/1F2E-33/d/Rysh.app/Contents/MacOS/Rysh', 'darwin')
    expect(r.kind).toBe('cannot-update')
    if (r.kind === 'cannot-update') expect(r.advice).toMatch(/Applications/)
  })
  it('running from the mounted disk image -> cannot update', () => {
    expect(updateLocation('/Volumes/Rysh 0.2.16-arm64/Rysh.app/Contents/MacOS/Rysh', 'darwin').kind).toBe('cannot-update')
  })
  it('a folder this user can write -> ok', () => {
    const apps = join(scratch(), 'Applications')
    mkdirSync(join(apps, 'Rysh.app/Contents/MacOS'), { recursive: true })
    expect(updateLocation(join(apps, 'Rysh.app/Contents/MacOS/Rysh'), 'darwin')).toEqual({ kind: 'ok' })
  })
  it('a folder this user cannot write (root-owned /Applications for a Standard user) -> needs-admin, naming the folder', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root writes anywhere
    const apps = join(scratch(), 'Applications')
    mkdirSync(join(apps, 'Rysh.app/Contents/MacOS'), { recursive: true })
    chmodSync(apps, 0o555)
    try {
      const r = updateLocation(join(apps, 'Rysh.app/Contents/MacOS/Rysh'), 'darwin')
      expect(r.kind).toBe('needs-admin')
      if (r.kind === 'needs-admin') expect(r.folder).toBe(apps)
    } finally {
      chmodSync(apps, 0o755) // let afterEach remove it
    }
  })
  it('not macOS, or not a bundle -> ok (Linux and dev runs are not judged here)', () => {
    expect(updateLocation('/opt/Rysh/rysh-desktop', 'linux')).toEqual({ kind: 'ok' })
    expect(updateLocation('/usr/local/bin/electron', 'darwin')).toEqual({ kind: 'ok' })
  })
})

describe('wiring (static)', () => {
  const au = readFileSync(resolve(__dirname, 'autoUpdate.ts'), 'utf8')
  it('a cannot-update location never downloads and never offers Restart Now; it explains once', () => {
    expect(au).toMatch(/updateLocation\(process\.execPath, process\.platform\)/)
    expect(au).toMatch(/autoUpdater\.autoDownload = this\.location\.kind !== 'cannot-update'/)
    expect(au).toMatch(/autoUpdater\.autoInstallOnAppQuit = this\.location\.kind !== 'cannot-update'/)
    expect(au).toMatch(/private async explainCannotUpdate\(/)
  })
  it('needs-admin: the restart dialog says macOS will ask for an administrator before the user picks Restart Now', () => {
    expect(au).toMatch(/administrator/)
  })
})
