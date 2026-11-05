// @vitest-environment node
//
// security-lead ledger 157 (CD1/CD2/CD3): the card's link is
// rysh://connect?server=…&token=…, so any web page can craft one that names
// another server. Before the app runs `ry connect`, it shows the server's host
// and needs an explicit yes for any server that is not rysh.ai or letchat.ai,
// refuses plain http to a non-loopback host (the one-time code would travel in
// clear), and hands the sidecar only the server and the one-time code: never a
// stored key or config.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { classifyConnectServer, confirmConnectServer, connectArgs, withoutSessionEnv } from './companyConnect'

const TOKEN = 'rysh_ct_' + 'a'.repeat(48)

describe('classifyConnectServer', () => {
  it('https://rysh.ai and https://letchat.ai are trusted', () => {
    expect(classifyConnectServer('https://rysh.ai')).toMatchObject({ kind: 'trusted', host: 'rysh.ai' })
    expect(classifyConnectServer('https://letchat.ai')).toMatchObject({ kind: 'trusted', host: 'letchat.ai' })
  })

  it('a host that only looks like rysh.ai needs a confirmation', () => {
    for (const s of ['https://rysh.ai.evil.example', 'https://evilrysh.ai', 'https://acme.rysh.ai', 'https://rysh.ai:8443']) {
      expect(classifyConnectServer(s).kind).toBe('confirm')
    }
  })

  it('userinfo in the URL is not trusted (https://rysh.ai@evil.example)', () => {
    const c = classifyConnectServer('https://rysh.ai@evil.example')
    expect(c.kind).not.toBe('trusted')
  })

  it('any other https server needs a confirmation that names its host', () => {
    expect(classifyConnectServer('https://dev.example.net')).toMatchObject({ kind: 'confirm', host: 'dev.example.net' })
  })

  it('http to loopback (a local server) needs a confirmation', () => {
    expect(classifyConnectServer('http://127.0.0.1:18080')).toMatchObject({ kind: 'confirm', host: '127.0.0.1:18080' })
    expect(classifyConnectServer('http://localhost:18080').kind).toBe('confirm')
  })

  it('plain http to any other host is refused', () => {
    const c = classifyConnectServer('http://rysh.ai')
    expect(c.kind).toBe('refuse')
    expect(classifyConnectServer('http://evil.example').kind).toBe('refuse')
  })

  it('a server that is not a URL is refused', () => {
    expect(classifyConnectServer('not a url').kind).toBe('refuse')
    expect(classifyConnectServer('ftp://rysh.ai').kind).toBe('refuse')
  })
})

describe('confirmConnectServer', () => {
  it('trusted: no question, ok', async () => {
    const ask = vi.fn()
    expect(await confirmConnectServer({ server: 'https://rysh.ai', token: TOKEN }, ask)).toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })

  it('other server: asks, naming the host; a yes goes on', async () => {
    const ask = vi.fn(async (_message: string, _detail: string) => true)
    expect(await confirmConnectServer({ server: 'https://dev.example.net', token: TOKEN }, ask)).toBeNull()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0] as string).toContain('dev.example.net')
  })

  it('other server: a no (or a closed dialog) stops the connect', async () => {
    const err = await confirmConnectServer({ server: 'https://dev.example.net', token: TOKEN }, async () => false)
    expect(err).toMatch(/cancel/i)
  })

  it('the question never shows the one-time code', async () => {
    const ask = vi.fn(async () => false)
    await confirmConnectServer({ server: 'https://dev.example.net', token: TOKEN }, ask)
    expect(JSON.stringify(ask.mock.calls)).not.toContain(TOKEN)
  })

  it('refused server: no question, an error naming the host', async () => {
    const ask = vi.fn()
    const err = await confirmConnectServer({ server: 'http://evil.example', token: TOKEN }, ask)
    expect(err).toContain('evil.example')
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('connectArgs: the sidecar gets only the server and the one-time code', () => {
  it('argv is exactly connect <server> <code> --json --device <label>', () => {
    expect(connectArgs({ server: 'https://rysh.ai', token: TOKEN }, 'Rysh Desktop on m')).toEqual([
      'connect',
      'https://rysh.ai',
      TOKEN,
      '--json',
      '--device',
      'Rysh Desktop on m',
    ])
  })

  it('main.ts asks confirmConnectServer before it calls runConnect', () => {
    const src = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    const fn = src.slice(src.indexOf('async function handleConnectLink'))
    const ask = fn.indexOf('confirmConnectServer(')
    const run = fn.indexOf('runConnect(')
    expect(ask).toBeGreaterThan(0)
    expect(run).toBeGreaterThan(ask)
  })
})

describe('withoutSessionEnv: the sidecar writes the company files into the company directory', () => {
  it('drops RYSH_DIR (with it, ry connect puts the secrets under RYSH_DIR, outside the company directory)', () => {
    const env = withoutSessionEnv({ RYSH_DIR: '/elsewhere/.rysh', RYSH_SESSION: 's', PATH: '/usr/bin', HOME: '/h' })
    expect(env.RYSH_DIR).toBeUndefined()
    expect(env.RYSH_SESSION).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/h')
  })
})
