import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  REQUIRED_HELP_FLAGS, decodeSetupJSON, parseChannel, parseCreds, parseOwner, scrubSecrets, setupArgs,
  setupCredEnv, stepsFromGuides,
} from './remoteSetupService'
import type {
  SetupBindingsReply, SetupChannel, SetupHoldReply, SetupReply, SetupStepsReply,
} from '../src/types/remoteSetup'

// "Set up remote access" (E33 slice C, founder ruling Q5): the desktop app
// drives the same `rysh setup` the terminal runs, in its headless --json form,
// with the binary the sidecar bundles. The app never re-implements setup.
//
// Credentials cross IPC once, on hold. Main keeps them under a one-time handle
// until apply, then sets them only in that one child's env, under the names its
// argv points at (--bot-token-env TELEGRAM_BOT_TOKEN): never argv, never the
// app's own env, never a file the app writes. Nothing on this path logs.

/** What the screens need from setup; the CLI runner below, or a fake in tests. */
export interface RemoteSetupRunner {
  steps(channel: SetupChannel): Promise<SetupStepsReply>
  /** Checks the credentials, writes the profile and starts the assistant. */
  apply(channel: SetupChannel, owner: string, creds: Record<string, string>): Promise<SetupReply>
  /** Waits for a real message from the owner to make the round trip. */
  verify(channel: SetupChannel): Promise<SetupReply>
  bindings(): Promise<SetupBindingsReply>
  cancel(): void
}

// verify: the CLI waits up to 120 s for the message (assistantVerifyTimeout), after restarting the channel.
const TIMEOUT_MS = { help: 15_000, steps: 30_000, apply: 120_000, verify: 180_000 }

interface ExecResult { error: (Error & { code?: string | number; killed?: boolean; signal?: string }) | null; stdout: string; stderr: string }

export class CliRemoteSetupRunner implements RemoteSetupRunner {
  private active: ChildProcess | undefined
  private busy = false
  private canceled = false
  private probed = new Set<string>()

  constructor(private binary: () => string, private workspace: () => string | null) {}

  async steps(channel: SetupChannel): Promise<SetupStepsReply> {
    const r = await this.run<SetupStepsReply & { guides?: [] }>(setupArgs('steps', { channel }), undefined, TIMEOUT_MS.steps, { steps: [] })
    return r.guides ? stepsFromGuides(channel, r) : r
  }
  // rysh setup has no JSON form for the bindings yet: answer without spawning it.
  async bindings(): Promise<SetupBindingsReply> {
    return { version: 1, ok: false, error: 'This rysh does not report bindings to the app yet; rysh doctor prints them.', bindings: [] }
  }
  apply(channel: SetupChannel, owner: string, creds: Record<string, string>): Promise<SetupReply> {
    return this.run(setupArgs('apply', { channel, owner }), setupCredEnv(channel, creds), TIMEOUT_MS.apply, { checks: [] })
  }
  verify(channel: SetupChannel): Promise<SetupReply> {
    return this.run(setupArgs('verify', { channel }), undefined, TIMEOUT_MS.verify, { checks: [] })
  }
  cancel(): void {
    if (this.active) {
      this.canceled = true
      this.active.kill('SIGTERM')
    }
  }

  private async run<T extends { version: number; ok: boolean; error?: string }>(
    args: string[], credEnv: Record<string, string> | undefined, timeout: number, empty: Omit<T, 'version' | 'ok' | 'error'>,
  ): Promise<T> {
    const fail = (error: string) => ({ version: 1, ok: false, error, ...empty }) as unknown as T
    if (this.busy) return fail('A setup step is already running — wait for it or cancel it.')
    const cwd = this.workspace()
    if (!cwd) return fail('Open a workspace first: remote access is set up per project directory.')
    this.busy = true
    this.canceled = false
    try {
      const binary = this.binary()
      const probe = await this.probe(binary, cwd)
      if (probe) return fail(probe)
      const values = credEnv ? Object.values(credEnv) : []
      const secrets = [...values, ...values.map((v) => JSON.stringify(v).slice(1, -1))]
      const res = await this.exec(binary, args, cwd, timeout, credEnv)
      const stdout = scrubSecrets(res.stdout, secrets)
      const stderr = scrubSecrets(res.stderr, secrets)
      if (res.error?.code === 'ENOENT') return fail(notFound(binary))
      if (res.error && (res.error.killed || res.error.signal)) {
        return fail(this.canceled ? 'Canceled.' : `rysh setup timed out after ${Math.round(timeout / 1000)}s.`)
      }
      try {
        return decodeSetupJSON<T>(stdout)
      } catch {
        if (res.error) {
          const why = lastLine(stderr) || lastLine(stdout)
          return fail(`rysh setup failed (exit ${res.error.code ?? '?'})${why ? `: ${why}` : ''}`)
        }
        return fail('Unexpected reply from rysh setup. Update the desktop app and rysh together.')
      }
    } finally {
      this.busy = false
    }
  }

  /** `setup --help` is safe on any rysh; an older one ignores unknown flags, so it must list the headless form before anything runs. */
  private async probe(binary: string, cwd: string): Promise<string | null> {
    if (this.probed.has(binary)) return null
    const res = await this.exec(binary, setupArgs('help', {}), cwd, TIMEOUT_MS.help)
    if (res.error?.code === 'ENOENT') return notFound(binary)
    const text = `${res.stdout}\n${res.stderr}`
    if (!REQUIRED_HELP_FLAGS.every((f) => text.includes(f))) {
      return 'This rysh has no headless setup yet (rysh setup --json). Update rysh, or run "rysh setup" in a terminal in this directory.'
    }
    this.probed.add(binary)
    return null
  }

  private exec(binary: string, args: string[], cwd: string, timeout: number, credEnv?: Record<string, string>): Promise<ExecResult> {
    return new Promise((resolve) => {
      // Direct executable + argv array: no shell. A credential, when there is
      // one, is only in this child's env (a copy; process.env is not touched).
      const child = execFile(binary, args, {
        cwd, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true,
        ...(credEnv ? { env: { ...process.env, ...credEnv } } : {}),
      }, (error, stdout, stderr) => {
        if (this.active === child) this.active = undefined
        resolve({ error: error as ExecResult['error'], stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
      this.active = child
      child.stdin?.on('error', () => { /* Process exit is reported by execFile. */ })
      child.stdin?.end() // --json never prompts; nothing goes on stdin
    })
  }
}

function notFound(binary: string): string {
  return `The rysh binary was not found at ${binary}. Reinstall the desktop app.`
}

function lastLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
}

const HANDLERS = [
  'remote-setup:steps', 'remote-setup:hold', 'remote-setup:apply', 'remote-setup:verify', 'remote-setup:bindings', 'remote-setup:cancel',
] as const
const HOLD_MS = 15 * 60_000

// Only the main app frame at the known renderer URL may run setup. Web panes,
// child frames and navigated main windows are rejected.
export function registerRemoteSetupHandlers(win: BrowserWindow, rendererURL: string, runner: RemoteSetupRunner): void {
  const expectedURL = new URL(rendererURL).href
  const held = new Map<string, { channel: SetupChannel; creds: Record<string, string>; expires: number }>()
  const allowed = (event: IpcMainInvokeEvent) => {
    if (win.isDestroyed() || event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame || event.senderFrame?.url !== expectedURL) {
      throw new Error('Remote setup is only available in the Rysh desktop window.')
    }
  }
  const reset = () => { runner.cancel(); held.clear() }
  win.on('closed', () => {
    reset()
    for (const name of HANDLERS) ipcMain.removeHandler(name)
  })
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) reset()
  })
  // allowed() throws synchronously; input errors reject the returned promise.
  const handle = (name: typeof HANDLERS[number], fn: (...args: any[]) => Promise<unknown> | unknown) => {
    ipcMain.handle(name, (event, ...args) => { allowed(event); return (async () => fn(...args))() })
  }
  const crashed = (): SetupReply => ({ version: 1, ok: false, error: 'rysh setup could not run.', checks: [] })

  handle('remote-setup:steps', (channel: unknown) => runner.steps(parseChannel(channel)))
  handle('remote-setup:hold', (channel: unknown, creds: unknown): SetupHoldReply => {
    const ch = parseChannel(channel)
    const c = parseCreds(ch, creds)
    const id = randomUUID()
    held.set(id, { channel: ch, creds: c, expires: Date.now() + HOLD_MS })
    return { ok: true, handle: id }
  })
  handle('remote-setup:apply', async (id: unknown, owner: unknown): Promise<SetupReply> => {
    const o = parseOwner(owner)
    const h = typeof id === 'string' ? held.get(id) : undefined
    if (typeof id === 'string') held.delete(id)
    if (!h || h.expires < Date.now()) {
      return { version: 1, ok: false, error: 'Paste the token again (it is used once and kept for 15 minutes at most).', checks: [] }
    }
    try { return await runner.apply(h.channel, o, h.creds) } catch { return crashed() }
  })
  handle('remote-setup:verify', async (channel: unknown) => {
    const ch = parseChannel(channel)
    try { return await runner.verify(ch) } catch { return crashed() }
  })
  handle('remote-setup:bindings', async () => {
    try { return await runner.bindings() } catch { return { version: 1, ok: false, error: 'rysh setup could not run.', bindings: [] } }
  })
  handle('remote-setup:cancel', () => { runner.cancel() })
}
