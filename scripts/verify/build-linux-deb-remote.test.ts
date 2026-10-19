// @vitest-environment node
//
// Regression test for the git remote that build-linux-deb.sh gives electron-builder
// (root-0406, W16 Ruling C): it must be the public repo, so the public tree never
// names the private one. Text checks only — the script is never executed.
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const SCRIPT = readFileSync(join(ROOT, 'scripts/verify/build-linux-deb.sh'), 'utf8')
const PUBLIC_REMOTE = 'https://github.com/rysh-ai/rysh-cli-app-code.git'

describe('build-linux-deb.sh git remote', () => {
  it('adds exactly one origin, and it is the public repo', () => {
    const urls = [...SCRIPT.matchAll(/git remote add origin (\S+)/g)].map((m) => m[1])
    expect(urls).toEqual([PUBLIC_REMOTE])
  })

  it('never names the private repo', () => {
    expect(SCRIPT.match(/rysh-ai\/rysh-cli-app(?!-code)/g)).toBeNull()
  })
})
