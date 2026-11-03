import {
  SETUP_CHANNEL_LABELS, SETUP_CHANNEL_ORDER, SETUP_CRED_FIELDS,
  type SetupChannel, type SetupLink, type SetupStepsReply,
} from '../src/types/remoteSetup'

// The argv side of "Set up remote access" (E33 slice C): what the app asks the
// bundled `rysh setup` to do, in its headless --json form (rysh-cli
// cmd/rysh/setup_cmd.go). Pure, so the two rules that matter are testable
// without a process:
//   - a credential never enters argv: argv names an env var (--bot-token-env
//     TELEGRAM_BOT_TOKEN) and the value is set only in that child's env, which
//     --store-secrets writes to .rysh/secrets for the already-running daemon;
//   - no flag that could loosen the approval gate is ever passed.

export type SetupOp = 'steps' | 'apply' | 'verify' | 'help'

/** Every flag the app may pass. Anything else is refused before a spawn. */
export const ALLOWED_SETUP_FLAGS: readonly string[] = [
  '--channel', '--owner', '--bot-token-env', '--app-token-env', '--store-secrets', '--steps-only',
  '--start', '--no-verify', '--verify', '--json', '--help',
]

/** Flags that set the gate (auto_approve, governance, allowlist, pairing) or rewrite an existing profile. */
export const GATE_FLAG_PATTERN = /^--(no-)?(auto[-_]?approve|governance|allow[-_]?list|pairing|reply[-_]?mode|overwrite[-_]?profile)/i

/** What `rysh setup --help` must list before the app runs it: an older rysh ignores unknown flags and would run a real setup. */
export const REQUIRED_HELP_FLAGS: readonly string[] = [
  '--json', '--channel', '--owner', '--<cred>-env', '--store-secrets', '--steps-only', '--start', '--no-verify', '--verify',
]

export function setupArgs(op: SetupOp, opts: { channel?: SetupChannel; owner?: string }): string[] {
  const ch = (): string[] => ['--channel', opts.channel as string]
  let args: string[]
  switch (op) {
    // Writes nothing: the bot-creation guide (Slack: the manifest and its create link).
    case 'steps': args = ['setup', '--steps-only', ...ch(), '--json']; break
    // One run checks the credentials, writes the profile and starts the
    // assistant in the session daemon. --store-secrets: the app's daemon is
    // already running and never sees this child's env, so the checked values
    // go to .rysh/secrets. --no-verify because the round trip is its own
    // screen (verify).
    case 'apply': args = ['setup', ...ch(), '--owner', opts.owner as string, ...credEnvFlags(opts.channel as SetupChannel), '--store-secrets', '--start', '--no-verify', '--json']; break
    // A re-run reuses the profile apply wrote (it is never rewritten) and waits
    // for the owner's first message.
    case 'verify': args = ['setup', ...ch(), '--start', '--verify', '--json']; break
    case 'help': args = ['setup', '--help']; break
  }
  assertSafeSetupArgs(args)
  return args
}

function credEnvFlags(channel: SetupChannel): string[] {
  return SETUP_CRED_FIELDS[channel].flatMap((f) => [`--${f.key.replace(/_/g, '-')}-env`, f.envName])
}

/** The child-only env entries carrying the credentials, under the names argv points at. */
export function setupCredEnv(channel: SetupChannel, creds: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const f of SETUP_CRED_FIELDS[channel]) env[f.envName] = creds[f.key]
  return env
}

const BOT_LINKS: Record<SetupChannel, SetupLink> = {
  telegram: { label: 'Open @BotFather', url: 'https://t.me/BotFather' },
  discord: { label: 'Discord developer portal', url: 'https://discord.com/developers/applications' },
  slack: { label: 'Slack apps', url: 'https://api.slack.com/apps' },
}

/** `rysh setup --steps-only --json` answers `{version, ok, guides:[{channel, steps, manifest?, create_url?}]}`. */
export function stepsFromGuides(channel: SetupChannel, r: { version: number; ok: boolean; error?: string; guides?: Array<{ channel: string; steps?: string[]; manifest?: string; create_url?: string }> }): SetupStepsReply {
  const g = r.guides?.find((x) => x.channel === channel)
  if (!r.ok || !g) {
    return { version: 1, ok: false, error: r.error ?? `rysh setup has no bot-creation guide for ${SETUP_CHANNEL_LABELS[channel]}.`, channel, steps: [] }
  }
  return {
    version: 1, ok: true, channel, steps: g.steps ?? [],
    ...(g.manifest ? { manifest: g.manifest } : {}),
    links: [g.create_url ? { label: 'Create from manifest', url: g.create_url } : BOT_LINKS[channel]],
  }
}

export function assertSafeSetupArgs(args: string[]): void {
  for (const a of args) {
    if (!a.startsWith('-')) continue
    if (GATE_FLAG_PATTERN.test(a) || !ALLOWED_SETUP_FLAGS.includes(a)) {
      throw new Error(`setup flag ${a.split('=')[0]} is not allowed from the app`)
    }
  }
}

export function parseChannel(v: unknown): SetupChannel {
  if (typeof v !== 'string' || !(SETUP_CHANNEL_ORDER as readonly string[]).includes(v)) {
    throw new Error('Choose Telegram, Discord or Slack.')
  }
  return v as SetupChannel
}

/** An owner id is a plain token: never a flag, no spaces or control characters. */
export function parseOwner(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@+:-]{0,63}$/.test(s)) {
    throw new Error('Enter your own user id on that app (letters and digits, no spaces).')
  }
  return s
}

/** Exactly the channel's secret fields, each a non-empty single line. Errors name the field, never the value. */
export function parseCreds(channel: SetupChannel, v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Missing credentials.')
  const fields = SETUP_CRED_FIELDS[channel]
  const input = v as Record<string, unknown>
  for (const k of Object.keys(input)) {
    if (!fields.some((f) => f.key === k)) throw new Error(`Unexpected credential field for ${channel}.`)
  }
  const out: Record<string, string> = {}
  for (const f of fields) {
    const raw = input[f.key]
    const s = typeof raw === 'string' ? raw.trim() : ''
    if (!s) throw new Error(`Paste the ${f.label.replace(/^(Telegram|Discord|Slack) /, '')}.`)
    if (Buffer.byteLength(s) > 4096 || /[\u0000-\u001f\u007f]/.test(s)) {
      throw new Error(`The ${f.label} does not look like a token (one line, no spaces).`)
    }
    out[f.key] = s
  }
  return out
}

/** One version-1 JSON object; the CLI may print human lines before it, so the last line is tried too. */
export function decodeSetupJSON<T extends { version: number }>(stdout: string): T {
  const text = stdout.trim()
  let r: any
  try { r = JSON.parse(text) } catch {
    const last = text.split('\n').pop() ?? ''
    r = JSON.parse(last)
  }
  if (!r || typeof r !== 'object' || r.version !== 1) {
    throw new Error('Update the Rysh desktop app and rysh together.')
  }
  return r as T
}

/** Belt and braces over the CLI's own redaction: no submitted value is ever shown back. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of secrets) {
    if (s) out = out.split(s).join('[redacted]')
  }
  return out
}
