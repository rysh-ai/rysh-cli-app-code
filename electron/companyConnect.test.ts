// @vitest-environment node
//
// CD2 (sprint 0.2.15, design 037): the company's read-only key no longer sits
// in plain rysh.config.yaml. The sidecar's `ry connect` writes the key with
// rysh-cli's secrets convention (config.WriteSecret, design 004): one 0600 file
// <directory>/.rysh/secrets/default/RYSH_UPSTREAM_API_KEY in 0700 dirs, and the
// YAML keeps the reference `upstream.api_key: ${RYSH_UPSTREAM_API_KEY}`, never a
// value. The app never writes either file; it checks what the sidecar wrote
// before it opens the workspace, and refuses to open a company whose key
// landed in plain YAML. The secrets file's content is never read here: only
// its type, owner and mode.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkConnectResult, type ConnectResult, type ConnectTarget } from './companyConnect'

const REF = '${RYSH_UPSTREAM_API_KEY}'

const NAMED_CONFIG =
  'upstream:\n' +
  '  enabled: true\n' +
  '  url: https://rysh.ai\n' +
  `  api_key: ${REF}\n` +
  '  workspace: ws-1\n'

const PLAIN_CONFIG =
  'upstream:\n' +
  '  enabled: true\n' +
  '  url: https://rysh.ai\n' +
  '  api_key: e12fake-not-a-real-key\n' +
  '  workspace: ws-1\n'

const KEY_FILE = ['.rysh', 'secrets', 'default', 'RYSH_UPSTREAM_API_KEY']
const TARGET: ConnectTarget = { server: 'https://rysh.ai', token: 'rysh_ct_' + 'a'.repeat(48) }
const check = (r: ConnectResult, t: ConnectTarget = TARGET): string | null => checkConnectResult(r, t)

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

/** A company directory as a fixed sidecar leaves it: the YAML holds the reference, the key a 0600 file in 0700 dirs. */
function company(config = NAMED_CONFIG): { result: ConnectResult; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cd2-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'rysh.config.yaml'), config)
  mkdirSync(join(dir, '.rysh', 'secrets', 'default'), { recursive: true, mode: 0o700 })
  chmodSync(join(dir, '.rysh', 'secrets'), 0o700)
  chmodSync(join(dir, '.rysh', 'secrets', 'default'), 0o700)
  writeFileSync(join(dir, ...KEY_FILE), 'e12fake\n', { mode: 0o600 })
  chmodSync(join(dir, ...KEY_FILE), 0o600)
  const result: ConnectResult = {
    directory: dir,
    config_file: join(dir, 'rysh.config.yaml'),
    secrets_file: join(dir, ...KEY_FILE),
    session: 'acme',
    server_url: 'https://rysh.ai',
    workspace_id: 'ws-1',
    company: { id: 'c1', name: 'Acme', slug: 'acme', fqdn: 'acme.rysh.ai', status: 'live' },
  }
  return { result, dir }
}

describe('checkConnectResult: what a fixed sidecar writes is accepted', () => {
  it('YAML holds the ${RYSH_UPSTREAM_API_KEY} reference, key file 0600 in 0700 dirs -> ok', () => {
    expect(check(company().result)).toBeNull()
  })

  it('a quoted reference is accepted', () => {
    expect(check(company(NAMED_CONFIG.replace(REF, `"${REF}"`)).result)).toBeNull()
  })
})

describe('checkConnectResult: a key in plain YAML is refused (fail closed)', () => {
  it('upstream.api_key with a value -> refused, and the message names the file', () => {
    const { result } = company(PLAIN_CONFIG)
    const err = check(result)
    expect(err).toMatch(/plain/i)
    expect(err).toContain(result.config_file)
  })

  it('the refusal never repeats the key value', () => {
    const err = check(company(PLAIN_CONFIG).result) || ''
    expect(err).not.toContain('e12fake-not-a-real-key')
  })

  it('a quoted plain value is refused too', () => {
    const err = check(company(NAMED_CONFIG + 'other:\n  api_key: "e12fake-q"\n').result)
    expect(err).toMatch(/plain/i)
  })

  it('the reference plus a second plain api_key elsewhere -> refused', () => {
    const err = check(company(NAMED_CONFIG + 'voice_control:\n  api_key: e12fake-voice\n').result) || ''
    expect(err).toMatch(/plain/i)
    expect(err).not.toContain('e12fake-voice')
  })

  it('no upstream.api_key reference in the YAML -> refused (the daemon could not find the key)', () => {
    const err = check(company('upstream:\n  enabled: true\n').result)
    expect(err).toContain(REF)
  })

  it('a reference to another name -> refused', () => {
    const err = check(company(NAMED_CONFIG.replace(REF, '${OTHER_KEY}')).result)
    expect(err).toContain(REF)
  })

  it('ledger 167: a second api_key naming any other ${NAME} -> refused (only the exact upstream ref is allowed)', () => {
    const err = check(company(NAMED_CONFIG + 'voice_control:\n  api_key: ${AWS_SECRET_ACCESS_KEY}\n').result) || ''
    expect(err).toContain(REF)
    expect(err).not.toContain('AWS_SECRET_ACCESS_KEY')
  })

  it('ledger 167: a ref with a scope or default (${default/X}, ${X:-y}) -> refused', () => {
    for (const v of ['${default/RYSH_UPSTREAM_API_KEY}', '${RYSH_UPSTREAM_API_KEY:-x}', '$RYSH_UPSTREAM_API_KEY']) {
      expect(check(company(NAMED_CONFIG.replace(REF, v)).result)).not.toBeNull()
    }
  })

  it('ledger 171 A1: flow-style YAML that the line check cannot read -> refused', () => {
    for (const extra of ['voice_control: {api_key: e12fake-flow}\n', 'x: [ {api_key: "${AWS_SECRET_ACCESS_KEY}"} ]\n', '? api_key\n: e12fake-complex\n']) {
      const err = check(company(NAMED_CONFIG + extra).result) || ''
      expect(err).not.toBe('')
      expect(err).not.toContain('e12fake')
    }
  })

  it('ledger 171 A1: a block scalar for api_key (| or >) -> refused', () => {
    for (const extra of ['other:\n  api_key: |\n    e12fake-block\n', 'other:\n  api_key: >-\n    e12fake-folded\n']) {
      expect(check(company(NAMED_CONFIG + extra).result)).not.toBeNull()
    }
  })

  it('a comment that mentions upstream.api_key (as ry connect writes one) is fine', () => {
    const commented = '# upstream.api_key is a READ-ONLY key for this company; revoke it from the dashboard.\n' + NAMED_CONFIG
    expect(check(company(commented).result)).toBeNull()
  })

  it('a key value anywhere in the --json result -> refused', () => {
    const { result } = company()
    const leaky = { ...result, company: { ...result.company, api_key: 'e12fake-json' } } as unknown as ConnectResult
    const err = check(leaky) || ''
    expect(err).toMatch(/key/i)
    expect(err).not.toContain('e12fake-json')
  })
})

describe('checkConnectResult: the secrets file must be private and where expected', () => {
  it('no secrets_file in the result (an old sidecar) -> refused', () => {
    const { result } = company()
    delete (result as Partial<ConnectResult>).secrets_file
    expect(check(result)).toMatch(/secrets/i)
  })

  it('secrets file missing on disk -> refused', () => {
    const { result } = company()
    rmSync(result.secrets_file)
    expect(check(result)).toMatch(/secrets/i)
  })

  it('secrets file readable by others (0644) -> refused', () => {
    const { result } = company()
    chmodSync(result.secrets_file, 0o644)
    expect(check(result)).toMatch(/0600|mode|private/i)
  })

  it('.rysh/secrets dir open to others (0755) -> refused', () => {
    const { result, dir } = company()
    chmodSync(join(dir, '.rysh', 'secrets'), 0o755)
    expect(check(result)).toMatch(/0700|mode|private/i)
  })

  it('.rysh/secrets/default dir open to others (0755) -> refused', () => {
    const { result, dir } = company()
    chmodSync(join(dir, '.rysh', 'secrets', 'default'), 0o755)
    expect(check(result)).toMatch(/0700|mode|private/i)
  })

  it('secrets file is a symlink -> refused', () => {
    const { result, dir } = company()
    rmSync(result.secrets_file)
    writeFileSync(join(dir, 'elsewhere'), 'x', { mode: 0o600 })
    symlinkSync(join(dir, 'elsewhere'), result.secrets_file)
    expect(check(result)).toMatch(/regular file|symlink/i)
  })

  it('secrets file other than <directory>/.rysh/secrets/default/RYSH_UPSTREAM_API_KEY -> refused', () => {
    const { result, dir } = company()
    writeFileSync(join(dir, 'other-secrets'), 'x', { mode: 0o600 })
    expect(check({ ...result, secrets_file: join(dir, 'other-secrets') })).toMatch(
      /\.rysh\/secrets\/default\/RYSH_UPSTREAM_API_KEY/
    )
  })

  it('config_file outside the company directory -> refused', () => {
    const { result } = company()
    const other = company()
    expect(check({ ...result, config_file: other.result.config_file })).toMatch(/outside|directory/i)
  })
})

describe('checkConnectResult: never a downgrade from the link (CD3 rehearsal finding, security-lead ledger 190 F-d)', () => {
  it('server_url http:// for an https link -> refused (the key would cross plain http)', () => {
    const { result } = company()
    expect(check({ ...result, server_url: 'http://rysh.ai' })).toMatch(/https|plain http/i)
  })
  it('server_url naming another host than the link -> refused', () => {
    const { result } = company()
    expect(check({ ...result, server_url: 'https://evil.example' })).toMatch(/evil\.example/)
  })
  it('server_url on another port than the link -> refused', () => {
    const { result } = company()
    expect(check({ ...result, server_url: 'https://rysh.ai:8443' })).not.toBeNull()
  })
  it('a url: line in the written config pointing at http:// -> refused even when server_url is https', () => {
    const { result } = company(NAMED_CONFIG.replace('url: https://rysh.ai', 'url: http://rysh.ai'))
    expect(check(result)).toMatch(/https|plain http/i)
  })
  it('a server: line naming another host -> refused', () => {
    const { result } = company(NAMED_CONFIG + 'company:\n  server: https://evil.example\n')
    expect(check(result)).toMatch(/evil\.example/)
  })
  it('the same origin with a trailing slash or path is the same server -> ok', () => {
    const { result } = company(NAMED_CONFIG.replace('url: https://rysh.ai', 'url: https://rysh.ai/'))
    expect(check({ ...result, server_url: 'https://rysh.ai/' })).toBeNull()
  })
  it('a local http server (127.0.0.1 link, the dev loop) stays allowed when the origins match', () => {
    const local: ConnectTarget = { server: 'http://127.0.0.1:18080', token: TARGET.token }
    const { result } = company(NAMED_CONFIG.replace('url: https://rysh.ai', 'url: http://127.0.0.1:18080'))
    expect(check({ ...result, server_url: 'http://127.0.0.1:18080' }, local)).toBeNull()
  })
})
