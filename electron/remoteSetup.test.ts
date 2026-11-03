// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const handlers = new Map<string, (...args: any[]) => any>()
const state = vi.hoisted(() => ({ exec: vi.fn(), handle: vi.fn(), remove: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: state.handle, removeHandler: state.remove } }))
vi.mock('node:child_process', () => ({ execFile: state.exec }))
import { CliRemoteSetupRunner, registerRemoteSetupHandlers, type RemoteSetupRunner } from './remoteSetup'
import {
  ALLOWED_SETUP_FLAGS, GATE_FLAG_PATTERN, REQUIRED_HELP_FLAGS, assertSafeSetupArgs, decodeSetupJSON,
  parseChannel, parseCreds, parseOwner, scrubSecrets, setupArgs, setupCredEnv, stepsFromGuides,
} from './remoteSetupService'

// Synthetic credential values only. A failing assertion names the test, never
// the value: every comparison against one is a boolean computed in-process.
const FAKE_TOKEN = 'fake-telegram-token-for-tests-only'
const FAKE_APP_TOKEN = 'fake-slack-app-token-for-tests-only'
// The flag lines of rysh-cli macmini ee778e3's `rysh setup --help` (cmd/rysh/setup_cmd.go printSetupUsage).
const HELP = [
  'usage: rysh setup                  guided (TTY): talk to your agent from your phone',
  '  --channel <app>          telegram | discord | slack | whatsapp | signal | imessage',
  '  --owner <id>             YOUR id on that app — the ONLY allowlisted sender',
  '  --<cred>-env <VAR>       a credential by name, e.g. --bot-token-env TELEGRAM_BOT_TOKEN',
  '  --start                  spawn the session daemon + assistant now',
  '  --verify / --no-verify   wait for your first real message (default: on in a TTY)',
  '  --store-secrets          after the checks pass, write each --<cred>-env / --key-env NAME',
  '  --steps-only             print the bot-creation steps (Slack: the app manifest) and',
  '  --json                   one JSON summary object on stdout (human text to stderr);',
].join('\n')
// The shape rysh-cli macmini's `rysh setup --json` prints (out/e33-setup-wizard-asbuilt.md there).
const LINE = 'telegram @my_bot → assistant (owner 42) → session default in /work/project; drives panes via pane_send'
const APPLY_REPLY = {
  version: 1, ok: true, dir: '/work/project', session: 'default', channel: 'telegram',
  profile: { path: '/work/project/.rysh/skills/assistant/SKILL.md', created: true },
  checks: [{ group: 'channel', status: 'PASS', detail: 'telegram — credentials valid (@my_bot)' },
    { group: 'daemon', status: 'INFO', detail: 'assistant active under session "default"' }],
  binding: { channel: 'telegram', bot: 'my_bot', handle: '@my_bot', humanoid: 'assistant', allowlist: ['42'],
    session: 'default', dir: '/work/project', line: LINE },
  auto_start: { installed: false }, verified: false, stored_secrets: ['TELEGRAM_BOT_TOKEN'], fails: 0,
}
const MANIFEST = 'display_information:\n  name: rysh\n'
const STEPS_REPLY = { version: 1, ok: true, guides: [{ channel: 'slack', steps: ['1. Open the link', '2. Install to workspace'],
  manifest: MANIFEST, create_url: 'https://api.slack.com/apps?new_app=1&manifest_yaml=x' }] }

const containsSecret = (v: unknown): boolean =>
  JSON.stringify(v ?? null).includes(FAKE_TOKEN) || JSON.stringify(v ?? null).includes(FAKE_APP_TOKEN)

beforeEach(() => { handlers.clear(); vi.clearAllMocks(); state.handle.mockImplementation((name, handler) => handlers.set(name, handler)) })

describe('remote setup argv', () => {
  const ops = [
    setupArgs('steps', { channel: 'slack' }),
    setupArgs('apply', { channel: 'discord', owner: '123456789012345678' }),
    setupArgs('apply', { channel: 'slack', owner: 'U012ABCDEF' }),
    setupArgs('verify', { channel: 'telegram' }),
    setupArgs('help', {}),
  ]

  it('builds the headless rysh setup argv: credentials by env NAME, never by value', () => {
    expect(setupArgs('apply', { channel: 'telegram', owner: '42' })).toEqual(
      ['setup', '--channel', 'telegram', '--owner', '42', '--bot-token-env', 'TELEGRAM_BOT_TOKEN', '--store-secrets', '--start', '--no-verify', '--json'])
    expect(setupArgs('apply', { channel: 'slack', owner: 'U1' })).toEqual(
      ['setup', '--channel', 'slack', '--owner', 'U1', '--bot-token-env', 'SLACK_BOT_TOKEN', '--app-token-env', 'SLACK_APP_TOKEN',
        '--store-secrets', '--start', '--no-verify', '--json'])
    expect(setupArgs('steps', { channel: 'telegram' })).toEqual(['setup', '--steps-only', '--channel', 'telegram', '--json'])
    // A re-run reuses the profile it wrote and waits for the owner's first message.
    expect(setupArgs('verify', { channel: 'discord' })).toEqual(['setup', '--channel', 'discord', '--start', '--verify', '--json'])
    expect(setupArgs('help', {})).toEqual(['setup', '--help'])
  })

  it('maps each credential field to the env name the CLI writes into the profile', () => {
    const env = setupCredEnv('slack', { bot_token: FAKE_TOKEN, app_token: FAKE_APP_TOKEN })
    expect(Object.keys(env)).toEqual(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'])
    expect(env.SLACK_BOT_TOKEN === FAKE_TOKEN && env.SLACK_APP_TOKEN === FAKE_APP_TOKEN).toBe(true)
    expect(Object.keys(setupCredEnv('telegram', { bot_token: FAKE_TOKEN }))).toEqual(['TELEGRAM_BOT_TOKEN'])
  })

  it('never passes a flag that sets auto_approve, governance, the allowlist or pairing', () => {
    for (const args of ops) {
      expect(args.filter((a) => GATE_FLAG_PATTERN.test(a))).toEqual([])
      expect(args.filter((a) => a.startsWith('-') && !ALLOWED_SETUP_FLAGS.includes(a))).toEqual([])
    }
    for (const bad of ['--auto-approve', '--auto_approve=true', '--governance', '--allowlist', '--allow-list', '--pairing-policy',
      '--reply-mode', '--overwrite-profile', '--no-auto-approve', '--install-daemon', '--bot-token', '--key']) {
      expect(() => assertSafeSetupArgs(['setup', bad, '--json'])).toThrow(/not allowed/)
    }
    for (const gate of ['--auto-approve', '--governance', '--allowlist', '--pairing-policy', '--overwrite-profile']) {
      expect(GATE_FLAG_PATTERN.test(gate)).toBe(true)
    }
  })

  it('validates channel, owner and credentials before any process starts', () => {
    expect(parseChannel('telegram')).toBe('telegram')
    for (const c of ['whatsapp', '', 1, '--json']) expect(() => parseChannel(c)).toThrow()
    expect(parseOwner(' 123456789 ')).toBe('123456789')
    expect(parseOwner('U012ABCDEF')).toBe('U012ABCDEF')
    for (const o of ['', '-1', '--auto-approve', 'a b', 'x\ny', 'x'.repeat(65), 7]) expect(() => parseOwner(o)).toThrow()
    expect(() => parseCreds('telegram', {})).toThrow(/bot token/)
    expect(() => parseCreds('telegram', { bot_token: 'x', app_token: 'y' })).toThrow()
    expect(() => parseCreds('telegram', { bot_token: 'x\ny' })).toThrow()
    expect(() => parseCreds('telegram', { bot_token: 7 })).toThrow()
    expect(() => parseCreds('slack', { bot_token: 'x' })).toThrow(/app-level token/)
    const ok = parseCreds('slack', { bot_token: ` ${FAKE_TOKEN} `, app_token: FAKE_APP_TOKEN })
    expect(ok.bot_token === FAKE_TOKEN && ok.app_token === FAKE_APP_TOKEN).toBe(true)
  })

  it('decodes only version-1 replies, maps the bot guides, and scrubs submitted secrets from text', () => {
    expect(decodeSetupJSON<any>(JSON.stringify(APPLY_REPLY) + '\n').binding.handle).toBe('@my_bot')
    expect(decodeSetupJSON<any>('note: x\n{"version":1,"ok":false,"error":"e","checks":[]}').error).toBe('e')
    expect(() => decodeSetupJSON('{"version":2,"ok":true}')).toThrow()
    expect(() => decodeSetupJSON('not json')).toThrow()
    expect(stepsFromGuides('slack', STEPS_REPLY)).toEqual({ version: 1, ok: true, channel: 'slack', steps: ['1. Open the link', '2. Install to workspace'],
      manifest: MANIFEST, links: [{ label: 'Create from manifest', url: 'https://api.slack.com/apps?new_app=1&manifest_yaml=x' }] })
    expect(stepsFromGuides('telegram', { version: 1, ok: true, guides: [{ channel: 'telegram', steps: ['1. a'] }] }).links).toEqual(
      [{ label: 'Open @BotFather', url: 'https://t.me/BotFather' }])
    const missing = stepsFromGuides('discord', { version: 1, ok: false, error: 'no bot-creation guide for "discord"', guides: [] })
    expect(missing.ok).toBe(false)
    expect(missing.error).toMatch(/no bot-creation guide/)
    const scrubbed = scrubSecrets(`bad token ${FAKE_TOKEN} here`, [FAKE_TOKEN])
    expect(scrubbed.includes(FAKE_TOKEN)).toBe(false)
    expect(scrubbed).toBe('bad token [redacted] here')
  })
})

describe('CliRemoteSetupRunner', () => {
  // execFile stand-in: answers `setup --help` with `help`, everything else with `reply`.
  function fakeExec(reply: { error?: any; stdout?: string; stderr?: string }, help = HELP) {
    const children: any[] = []
    state.exec.mockImplementation((_file, args: string[], _options, callback) => {
      const child = { stdin: { end: vi.fn(), on: vi.fn() }, kill: vi.fn() }
      children.push(child)
      queueMicrotask(() => {
        if (args.includes('--help')) callback(null, help, '')
        else callback(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? '')
      })
      return child
    })
    return children
  }
  const runner = (dir: string | null = '/work/project') => new CliRemoteSetupRunner(() => '/bundled/rysh', () => dir)
  const call = (i: number) => state.exec.mock.calls[i]

  it('spawns the bundled rysh with an argv array in the workspace, the token only in the child env', async () => {
    const children = fakeExec({ stdout: JSON.stringify(APPLY_REPLY) + '\n' })
    const before = { ...process.env }
    const r = await runner().apply('telegram', '42', { bot_token: FAKE_TOKEN })
    expect(containsSecret(r)).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.binding?.handle).toBe('@my_bot')
    expect(call(0).slice(0, 2)).toEqual(['/bundled/rysh', ['setup', '--help']])
    expect(containsSecret(call(0)[2])).toBe(false)
    const [file, args, options] = call(1)
    expect(containsSecret(args)).toBe(false)
    expect(file).toBe('/bundled/rysh')
    expect(args).toEqual(['setup', '--channel', 'telegram', '--owner', '42', '--bot-token-env', 'TELEGRAM_BOT_TOKEN', '--store-secrets', '--start', '--no-verify', '--json'])
    expect(options.cwd).toBe('/work/project')
    expect(options.shell).toBeFalsy()
    expect(options.env.TELEGRAM_BOT_TOKEN === FAKE_TOKEN).toBe(true)
    const { env: _env, ...rest } = options
    expect(containsSecret(rest)).toBe(false)
    expect(options.env.PATH === process.env.PATH).toBe(true) // the child keeps the app's environment
    expect(containsSecret(process.env)).toBe(false) // the app's own env never holds the token
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort())
    expect(children[1].stdin.end).toHaveBeenCalledWith() // nothing on stdin
  })

  it('verify re-runs setup with no credential in its env', async () => {
    fakeExec({ stdout: JSON.stringify({ ...APPLY_REPLY, verified: true }) })
    const r = await runner().verify('telegram')
    expect(r.verified).toBe(true)
    const [, args, options] = call(1)
    expect(args).toEqual(['setup', '--channel', 'telegram', '--start', '--verify', '--json'])
    expect(options.env).toBeUndefined()
  })

  it('steps come from rysh setup --steps-only --json, with no credential in the env', async () => {
    fakeExec({ stdout: JSON.stringify(STEPS_REPLY) + '\n' })
    const s = await runner().steps('slack')
    expect(s.ok).toBe(true)
    expect(s.manifest).toBe(MANIFEST)
    expect(s.links?.[0].label).toBe('Create from manifest')
    const [, args, options] = call(1)
    expect(args).toEqual(['setup', '--steps-only', '--channel', 'slack', '--json'])
    expect(options.env).toBeUndefined()
  })

  it('bindings answer without running setup (this rysh has no JSON form for them)', async () => {
    fakeExec({ stdout: '{}' })
    const b = await runner().bindings()
    expect(b.ok).toBe(false)
    expect(b.bindings).toEqual([])
    expect(state.exec).not.toHaveBeenCalled()
  })

  it('refuses to run when the bundled rysh has no headless setup (old binary ignores unknown flags)', async () => {
    fakeExec({ stdout: '{}' }, 'usage: rysh setup\n  --channel <app>\n')
    const r = await runner().apply('telegram', '42', { bot_token: FAKE_TOKEN })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/update rysh/i)
    expect(state.exec).toHaveBeenCalledTimes(1) // the probe only — setup itself never ran
    expect(REQUIRED_HELP_FLAGS.every((f) => HELP.includes(f))).toBe(true)
  })

  it('needs an open workspace: setup is project-local', async () => {
    fakeExec({ stdout: '{}' })
    const r = await runner(null).apply('telegram', '42', { bot_token: FAKE_TOKEN })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/workspace/i)
    expect(state.exec).not.toHaveBeenCalled()
  })

  it('shows a failing reply verbatim (FAIL/WARN lines and fixes)', async () => {
    const reply = { version: 1, ok: false, error: 'setup saved, but 1 check(s) FAILed', checks: [
      { group: 'channel', status: 'FAIL', detail: 'telegram: getMe: 401 Unauthorized (token ${TELEGRAM_BOT_TOKEN})', fixes: ['##secret new TELEGRAM_BOT_TOKEN'] },
      { group: 'daemon', status: 'INFO', detail: 'not starting the telegram channel' }] }
    fakeExec({ error: Object.assign(new Error('exit 1'), { code: 1 }), stdout: JSON.stringify(reply) })
    const r = await runner().apply('telegram', '42', { bot_token: FAKE_TOKEN })
    expect(r).toEqual(reply)
  })

  it('maps a non-JSON failure to the last stderr line, verbatim but with submitted secrets scrubbed', async () => {
    fakeExec({ error: Object.assign(new Error('exit 2'), { code: 2 }), stdout: '', stderr: `warming up\nerror: token ${FAKE_TOKEN} rejected\n` })
    const r = await runner().apply('telegram', '42', { bot_token: FAKE_TOKEN })
    expect(containsSecret(r)).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('rysh setup failed (exit 2): error: token [redacted] rejected')
  })

  it('maps a missing binary and a timeout to plain messages', async () => {
    state.exec.mockImplementation((_f, _a, _o, cb) => { queueMicrotask(() => cb(Object.assign(new Error('spawn'), { code: 'ENOENT' }), '', '')); return { stdin: { end: vi.fn(), on: vi.fn() }, kill: vi.fn() } })
    expect((await runner().verify('telegram')).error).toMatch(/rysh binary was not found/)
    let n = 0
    state.exec.mockImplementation((_f, _a, _o, cb) => {
      const first = n++ === 0
      queueMicrotask(() => first ? cb(null, HELP, '') : cb(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' }), '', ''))
      return { stdin: { end: vi.fn(), on: vi.fn() }, kill: vi.fn() }
    })
    expect((await new CliRemoteSetupRunner(() => '/other/rysh', () => '/w').verify('telegram')).error).toMatch(/timed out/)
  })

  it('runs one setup process at a time and cancels it', async () => {
    let complete: (...a: any[]) => void = () => {}
    const child = { stdin: { end: vi.fn(), on: vi.fn() }, kill: vi.fn() }
    state.exec.mockImplementation((_f, args: string[], _o, cb) => {
      if (args.includes('--help')) { queueMicrotask(() => cb(null, HELP, '')); return { stdin: { end: vi.fn(), on: vi.fn() }, kill: vi.fn() } }
      complete = cb
      return child
    })
    const r = runner()
    const pending = r.verify('telegram')
    await new Promise((res) => setTimeout(res, 0))
    expect((await r.apply('telegram', '42', { bot_token: FAKE_TOKEN })).error).toMatch(/already running/)
    r.cancel()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    complete(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', '')
    expect((await pending).ok).toBe(false)
  })
})

describe('remote setup IPC', () => {
  function fakeRunner() {
    return {
      steps: vi.fn(async (..._a: any[]) => ({ version: 1, ok: true, steps: ['1. open @BotFather'] })),
      apply: vi.fn(async (..._a: any[]) => ({ version: 1, ok: true, checks: [], binding: APPLY_REPLY.binding })),
      verify: vi.fn(async (..._a: any[]) => ({ version: 1, ok: true, verified: true, checks: [] })),
      bindings: vi.fn(async (..._a: any[]) => ({ version: 1, ok: true, bindings: [] })),
      cancel: vi.fn(),
    }
  }
  function setup() {
    const frame = { url: 'file:///app/index.html' }
    const contents = { mainFrame: frame, on: vi.fn() }
    const win = { isDestroyed: () => false, webContents: contents, on: vi.fn() }
    const r = fakeRunner()
    registerRemoteSetupHandlers(win as any, frame.url, r as unknown as RemoteSetupRunner)
    return { win, r, event: { sender: contents, senderFrame: frame }, contents, frame }
  }

  it('rejects web panes, subframes and navigated windows', () => {
    const { r, contents, frame } = setup()
    for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: { url: frame.url } }]) {
      expect(() => handlers.get('remote-setup:hold')!(event, 'telegram', { bot_token: FAKE_TOKEN })).toThrow(/desktop window/)
    }
    frame.url = 'https://evil.invalid/'
    expect(() => handlers.get('remote-setup:steps')!({ sender: contents, senderFrame: frame }, 'telegram')).toThrow()
    expect(r.steps).not.toHaveBeenCalled()
  })

  it('holds the credentials in main under a one-time handle; the renderer never gets them back', async () => {
    const { r, event } = setup()
    const v = await handlers.get('remote-setup:hold')!(event, 'telegram', { bot_token: FAKE_TOKEN })
    expect(containsSecret(v)).toBe(false)
    expect(v.ok).toBe(true)
    expect(typeof v.handle).toBe('string')
    const a = await handlers.get('remote-setup:apply')!(event, v.handle, '42')
    expect(containsSecret(a)).toBe(false)
    expect(a.binding.bot).toBe('my_bot')
    expect(r.apply.mock.calls[0][0]).toBe('telegram')
    expect(r.apply.mock.calls[0][1]).toBe('42')
    expect(r.apply.mock.calls[0][2].bot_token === FAKE_TOKEN).toBe(true)
    const again = await handlers.get('remote-setup:apply')!(event, v.handle, '42')
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/paste the token again/i)
    expect(r.apply).toHaveBeenCalledTimes(1)
  })

  it('rejects bad input before the runner', async () => {
    const { r, event } = setup()
    await expect(handlers.get('remote-setup:hold')!(event, 'telegram', {})).rejects.toThrow()
    await expect(handlers.get('remote-setup:steps')!(event, 'irc')).rejects.toThrow()
    const v = await handlers.get('remote-setup:hold')!(event, 'telegram', { bot_token: FAKE_TOKEN })
    await expect(handlers.get('remote-setup:apply')!(event, v.handle, '--auto-approve')).rejects.toThrow()
    expect(r.steps).not.toHaveBeenCalled()
    expect(r.apply).not.toHaveBeenCalled()
  })

  it('never logs an IPC payload on the setup path', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const { r, event } = setup()
    r.apply.mockRejectedValueOnce(new Error('boom'))
    const v = await handlers.get('remote-setup:hold')!(event, 'telegram', { bot_token: FAKE_TOKEN })
    await handlers.get('remote-setup:apply')!(event, v.handle, '42')
    for (const s of spies) expect(containsSecret(s.mock.calls)).toBe(false)
  })

  it('drops held credentials and handlers when the window closes', async () => {
    const { win, r, event } = setup()
    const v = await handlers.get('remote-setup:hold')!(event, 'telegram', { bot_token: FAKE_TOKEN })
    win.on.mock.calls.find(([name]) => name === 'closed')![1]()
    expect(r.cancel).toHaveBeenCalled()
    expect(state.remove.mock.calls.map(([name]) => name)).toEqual([
      'remote-setup:steps', 'remote-setup:hold', 'remote-setup:apply', 'remote-setup:verify', 'remote-setup:bindings', 'remote-setup:cancel',
    ])
    expect((await handlers.get('remote-setup:apply')!(event, v.handle, '42')).ok).toBe(false)
  })
})
