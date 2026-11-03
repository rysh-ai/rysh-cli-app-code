// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// E12 order 31: the app finds the processes it may stop from its own records
// (the daemon registry and the session record), never by matching a pattern
// against the process table. This scans every code line under electron/ and
// src/ for the pattern tools, and for a process-table tool run by bare name
// (it must be an absolute path, never resolved from PATH). Comments are not
// code and are skipped. The tool names are split so this file does not match.

const PATTERN_TOOLS = new RegExp('\\b(' + ['pg' + 'rep', 'pk' + 'ill', 'kill' + 'all', 'task' + 'kill'].join('|') + ')\\b')
const BARE_PROC_TOOL = new RegExp('exec(File)?(Sync)?\\(\\s*[\'"`](' + ['p' + 's', 'ls' + 'of'].join('|') + ')[\'"`]')

/** The code part of each line: line comments, block-comment lines and JSDoc lines dropped. */
export function codeLines(text: string): { n: number; code: string }[] {
  const out: { n: number; code: string }[] = []
  let inBlock = false
  text.split('\n').forEach((raw, i) => {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) return
      line = line.slice(end + 2)
      inBlock = false
    }
    const start = line.indexOf('/*')
    if (start >= 0) {
      const end = line.indexOf('*/', start + 2)
      if (end < 0) {
        inBlock = true
        line = line.slice(0, start)
      } else {
        line = line.slice(0, start) + line.slice(end + 2)
      }
    }
    const lc = line.search(/(^|[^:])\/\//)
    if (lc >= 0) line = line.slice(0, lc)
    if (line.trim()) out.push({ n: i + 1, code: line })
  })
  return out
}

export function hits(text: string): number[] {
  return codeLines(text)
    .filter((l) => PATTERN_TOOLS.test(l.code) || BARE_PROC_TOOL.test(l.code))
    .map((l) => l.n)
}

function sources(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files.push(...sources(p))
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) files.push(p)
  }
  return files
}

const ROOT = join(__dirname, '..')

describe('no pattern-based process lookup or kill (order 31)', () => {
  it('needle control: the matcher catches each planted line and skips comments', () => {
    const planted = [
      "out = execFileSync('" + 'pg' + "rep', ['-f', binaryPath])",
      "execFileSync('" + 'task' + "kill', ['/F', '/IM', image])",
      "spawn('" + 'pk' + "ill', ['-f', 'x'])",
      "execFileSync('" + 'p' + "s', ['-o', 'comm=', '-p', pid])",
      "execFileSync('" + 'ls' + "of', ['-p', pid])",
    ]
    const control = [
      '// ' + 'pg' + 'rep exits non-zero when nothing matched',
      '/**',
      ' * ' + 'kill' + 'all is never used',
      ' */',
      '/* ' + 'pk' + 'ill, inline */ const x = 1',
      "execFileSync('/bin/" + 'p' + "s', ['-o', 'pgid=', '-p', pid])",
      "execFileSync('/usr/sbin/" + 'ls' + "of', ['-a', '-p', pid])",
    ]
    const text = [...planted, ...control].join('\n')
    expect(hits(text)).toEqual([1, 2, 3, 4, 5])
  })

  it('electron/ and src/ have no such code line', () => {
    const files = [...sources(join(ROOT, 'electron')), ...sources(join(ROOT, 'src'))]
    // The scan is not vacuous: it reads the files that matter.
    expect(files.length).toBeGreaterThan(50)
    expect(files.map((f) => relative(ROOT, f))).toContain(join('electron', 'sidecar.ts'))
    const found: string[] = []
    for (const f of files) {
      for (const n of hits(readFileSync(f, 'utf-8'))) found.push(`${relative(ROOT, f)}:${n}`)
    }
    expect(found).toEqual([])
  })
})
