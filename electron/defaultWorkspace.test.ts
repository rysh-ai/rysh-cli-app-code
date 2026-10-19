// @vitest-environment node
//
// E-90 (founder ruling R8): on a first run — no last workspace AND no recent
// workspaces — the app creates ~/rysh-workspace (or $RYSH_DEFAULT_WORKSPACE)
// and opens it, so a pane works with no CLI and no dialog. Everything else
// about boot stays as it was; these tests pin both halves.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_CONFIG,
  DEFAULT_WORKSPACE_DIRNAME,
  DEFAULT_WORKSPACE_ENV,
  defaultWorkspacePath,
  ensureDefaultWorkspace,
  planBoot,
  type BootInputs,
} from './defaultWorkspace'

const fresh: BootInputs = { hasLast: false, lastValid: false, recentCount: 0, isPrimary: true, pendingConnectLinks: 0 }

describe('planBoot — when the first-run default workspace is created', () => {
  it('first run (no last, no recents, primary, no connect link) -> auto-create', () => {
    expect(planBoot(fresh)).toEqual({ kind: 'auto-create-default' })
  })

  it('UNCHANGED: a valid last workspace reopens as before', () => {
    expect(planBoot({ ...fresh, hasLast: true, lastValid: true, recentCount: 3 })).toEqual({ kind: 'reopen-last' })
  })

  it('UNCHANGED: recents but no last (e.g. after Close Workspace) -> welcome with recents, no auto-create', () => {
    const p = planBoot({ ...fresh, recentCount: 2 })
    expect(p.kind).toBe('welcome')
  })

  it('a last workspace that no longer validates -> welcome (not a first run, never auto-create)', () => {
    const p = planBoot({ ...fresh, hasLast: true, lastValid: false })
    expect(p.kind).toBe('welcome')
  })

  it('UNCHANGED connect-code path: a pending rysh:// connect link -> no auto-create, the link opens its own workspace', () => {
    const p = planBoot({ ...fresh, pendingConnectLinks: 1 })
    expect(p.kind).toBe('welcome')
  })

  it('a secondary instance never auto-creates (it would adopt the primary\'s daemon on the same folder)', () => {
    const p = planBoot({ ...fresh, isPrimary: false })
    expect(p.kind).toBe('welcome')
  })

  it('every welcome plan says why, for the [main] log line', () => {
    for (const i of [{ ...fresh, recentCount: 1 }, { ...fresh, pendingConnectLinks: 1 }, { ...fresh, isPrimary: false }]) {
      const p = planBoot(i)
      expect(p.kind === 'welcome' && p.reason.length > 0).toBe(true)
    }
  })
})

describe('defaultWorkspacePath — configurable via RYSH_DEFAULT_WORKSPACE', () => {
  it('defaults to ~/rysh-workspace', () => {
    expect(DEFAULT_WORKSPACE_DIRNAME).toBe('rysh-workspace')
    expect(DEFAULT_WORKSPACE_ENV).toBe('RYSH_DEFAULT_WORKSPACE')
    expect(defaultWorkspacePath({}, '/home/u')).toBe('/home/u/rysh-workspace')
  })

  it('blank env value -> the default', () => {
    expect(defaultWorkspacePath({ RYSH_DEFAULT_WORKSPACE: '   ' }, '/home/u')).toBe('/home/u/rysh-workspace')
  })

  it('absolute env value is used as is', () => {
    expect(defaultWorkspacePath({ RYSH_DEFAULT_WORKSPACE: '/data/ws' }, '/home/u')).toBe('/data/ws')
  })

  it('~ and ~/x expand to the home directory', () => {
    expect(defaultWorkspacePath({ RYSH_DEFAULT_WORKSPACE: '~/projects/rysh' }, '/home/u')).toBe('/home/u/projects/rysh')
    expect(defaultWorkspacePath({ RYSH_DEFAULT_WORKSPACE: '~' }, '/home/u')).toBe('/home/u')
  })

  it('a relative env value resolves against the home directory, never the process cwd', () => {
    expect(defaultWorkspacePath({ RYSH_DEFAULT_WORKSPACE: 'ws' }, '/home/u')).toBe('/home/u/ws')
  })
})

describe('ensureDefaultWorkspace — create, reuse, or refuse; never overwrite', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        chmodSync(d, 0o755)
      } catch {
        /* already gone */
      }
      rmSync(d, { recursive: true, force: true })
    }
  })
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'rysh-e90-'))
    dirs.push(d)
    return d
  }
  // The app's own gate (WorkspaceManager.validateWorkspace), reduced to the
  // sibling-file case the default workspace uses.
  const isValid = (dir: string): boolean => existsSync(join(dir, 'rysh.config.yaml'))

  it('missing -> creates the folder and writes rysh.config.yaml, which then passes the app gate', () => {
    const target = join(tmp(), 'rysh-workspace')
    expect(ensureDefaultWorkspace(target, isValid)).toEqual({ kind: 'created', path: target })
    expect(readFileSync(join(target, 'rysh.config.yaml'), 'utf8')).toBe(DEFAULT_WORKSPACE_CONFIG)
    expect(isValid(target)).toBe(true)
  })

  it('missing parents are created too (a configured nested path)', () => {
    const target = join(tmp(), 'a', 'b', 'ws')
    expect(ensureDefaultWorkspace(target, isValid).kind).toBe('created')
    expect(isValid(target)).toBe(true)
  })

  it('the written config is comment-only: rysh loads it exactly like no config (proved against the CLI loader)', () => {
    const lines = DEFAULT_WORKSPACE_CONFIG.split('\n').filter((l) => l.trim() !== '')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.trimStart().startsWith('#'))).toBe(true)
  })

  it('exists and valid -> opened as is, config untouched', () => {
    const target = join(tmp(), 'rysh-workspace')
    mkdirSync(target)
    writeFileSync(join(target, 'rysh.config.yaml'), 'rysh:\n  session_name: mine\n')
    expect(ensureDefaultWorkspace(target, isValid)).toEqual({ kind: 'existing', path: target })
    expect(readFileSync(join(target, 'rysh.config.yaml'), 'utf8')).toBe('rysh:\n  session_name: mine\n')
  })

  it('exists but NOT a workspace -> unusable, nothing written into it', () => {
    const target = join(tmp(), 'rysh-workspace')
    mkdirSync(target)
    writeFileSync(join(target, 'notes.txt'), 'mine')
    const r = ensureDefaultWorkspace(target, isValid)
    expect(r.kind).toBe('unusable')
    expect(r.kind === 'unusable' && r.reason).toMatch(/not a rysh workspace/)
    expect(existsSync(join(target, 'rysh.config.yaml'))).toBe(false)
  })

  it('an empty existing folder is not adopted either (never write into a folder we did not create)', () => {
    const target = join(tmp(), 'rysh-workspace')
    mkdirSync(target)
    expect(ensureDefaultWorkspace(target, isValid).kind).toBe('unusable')
    expect(existsSync(join(target, 'rysh.config.yaml'))).toBe(false)
  })

  it('the path is a FILE -> unusable, file untouched', () => {
    const target = join(tmp(), 'rysh-workspace')
    writeFileSync(target, 'a file')
    const r = ensureDefaultWorkspace(target, isValid)
    expect(r.kind).toBe('unusable')
    expect(readFileSync(target, 'utf8')).toBe('a file')
  })

  it('creation fails (parent not writable) -> unusable with the OS reason, no throw', () => {
    if (process.getuid?.() === 0) return // root ignores the mode bits
    const parent = tmp()
    chmodSync(parent, 0o555)
    const r = ensureDefaultWorkspace(join(parent, 'rysh-workspace'), isValid)
    expect(r.kind).toBe('unusable')
    expect(r.kind === 'unusable' && r.reason).toMatch(/EACCES|permission/i)
  })
})
