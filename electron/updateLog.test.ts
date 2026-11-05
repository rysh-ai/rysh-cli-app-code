// @vitest-environment node
//
// R8b finding (sprint 0.2.14): the updater logged only to stdout, so an app
// started from Finder (LaunchServices) left no record of whether it checked,
// found or downloaded an update. The updater now also writes a file in the
// user's log directory (<app logs>/updater.log): this user's own 0600 file in a
// 0700 directory, never through a symlink, capped in size, and a write problem
// never reaches the app.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUpdateLog, UPDATE_LOG_NAME } from './updateLog'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'updlog-'))
  dirs.push(d)
  return d
}

describe('createUpdateLog', () => {
  it('writes timestamped lines to <dir>/updater.log, one per call, with the level', () => {
    const dir = join(scratch(), 'logs')
    const log = createUpdateLog(dir)
    log.info('Checking for updates...')
    log.error('Error: boom')
    const text = readFileSync(join(dir, UPDATE_LOG_NAME), 'utf8')
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z info  Checking for updates\.\.\.$/)
    expect(lines[1]).toMatch(/ error Error: boom$/)
  })

  it('creates the directory 0700 and the file 0600', () => {
    const dir = join(scratch(), 'a', 'logs')
    createUpdateLog(dir).info('x')
    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(dir, UPDATE_LOG_NAME)).mode & 0o777).toBe(0o600)
  })

  it('an existing file open to others is made 0600 before the next write', () => {
    const dir = scratch()
    writeFileSync(join(dir, UPDATE_LOG_NAME), 'old\n', { mode: 0o644 })
    chmodSync(join(dir, UPDATE_LOG_NAME), 0o644)
    createUpdateLog(dir).info('x')
    expect(lstatSync(join(dir, UPDATE_LOG_NAME)).mode & 0o777).toBe(0o600)
  })

  it('never writes through a symlink at the log path (the target stays untouched)', () => {
    const dir = scratch()
    const target = join(dir, 'elsewhere.txt')
    writeFileSync(target, 'keep\n')
    symlinkSync(target, join(dir, UPDATE_LOG_NAME))
    createUpdateLog(dir).info('x')
    expect(readFileSync(target, 'utf8')).toBe('keep\n')
  })

  it('rotates to updater.log.1 past the size cap, keeping one old file', () => {
    const dir = scratch()
    const log = createUpdateLog(dir, { maxBytes: 200 })
    for (let i = 0; i < 20; i++) log.info(`line ${i} ` + 'x'.repeat(20))
    expect(existsSync(join(dir, UPDATE_LOG_NAME + '.1'))).toBe(true)
    expect(existsSync(join(dir, UPDATE_LOG_NAME + '.2'))).toBe(false)
    expect(lstatSync(join(dir, UPDATE_LOG_NAME)).size).toBeLessThanOrEqual(200 + 80)
    expect(readFileSync(join(dir, UPDATE_LOG_NAME), 'utf8')).toContain('line 19')
  })

  it('a log dir it cannot create or write never throws to the caller', () => {
    const base = scratch()
    writeFileSync(join(base, 'file'), 'x')
    const log = createUpdateLog(join(base, 'file', 'logs'))
    expect(() => log.info('x')).not.toThrow()
    expect(() => log.warn('x')).not.toThrow()
    expect(() => log.error(new Error('e'))).not.toThrow()
  })

  it('accepts what electron-updater passes its logger (strings, Errors, objects) on one line each', () => {
    const dir = scratch()
    const log = createUpdateLog(dir)
    log.info('a\nb')
    log.error(new Error('bad\nthing'))
    log.debug?.({ k: 1 })
    const lines = readFileSync(join(dir, UPDATE_LOG_NAME), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/ info  a b$/)
    expect(lines[1]).toContain('bad thing')
    expect(lines[2]).toContain('{"k":1}')
  })

  it('a 0700 dir that already exists is left as it is (not opened up)', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'logs'), { mode: 0o700 })
    createUpdateLog(join(dir, 'logs')).info('x')
    expect(lstatSync(join(dir, 'logs')).mode & 0o777).toBe(0o700)
  })
})

describe('AutoUpdateManager wiring (static)', () => {
  const src = readFileSync(join(__dirname, 'autoUpdate.ts'), 'utf8')
  it('hands electron-updater the file logger', () => {
    expect(src).toMatch(/autoUpdater\.logger\s*=\s*this\.log/)
  })
  it('every event handler writes to the file log, not only the console', () => {
    for (const ev of ['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'error']) {
      const at = src.indexOf(`'${ev}'`)
      expect(at).toBeGreaterThan(0)
      expect(src.slice(at, at + 400)).toMatch(/this\.log\.(info|error)\(/)
    }
  })
  it('main.ts gives it the user log directory', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    expect(main).toMatch(/new AutoUpdateManager\(mainWindow,\s*app\.getPath\('logs'\)\)/)
  })
})
