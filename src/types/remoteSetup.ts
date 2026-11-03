// Shapes of `rysh setup --json` (E33 slice C). The desktop app drives the CLI's
// headless setup; it never re-implements it. Version 1; the CLI only ever adds
// fields. No reply carries a credential value — names and statuses only.

/** The chat apps the app offers, in this order (founder ruling Q2). */
export type SetupChannel = 'telegram' | 'discord' | 'slack'
export const SETUP_CHANNEL_ORDER: readonly SetupChannel[] = ['telegram', 'discord', 'slack']

export const SETUP_CHANNEL_LABELS: Record<SetupChannel, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
}

/**
 * One secret the channel needs. `key` is the CLI's field key (bot_token,
 * app_token); `envName` is the reference the CLI writes into the profile
 * (`${TELEGRAM_BOT_TOKEN}`, rysh-cli cmd/rysh/skill_scaffold.go channelCredFields).
 */
export interface SetupCredField {
  key: string
  label: string
  envName: string
}

export const SETUP_CRED_FIELDS: Record<SetupChannel, readonly SetupCredField[]> = {
  telegram: [{ key: 'bot_token', label: 'Telegram bot token', envName: 'TELEGRAM_BOT_TOKEN' }],
  discord: [{ key: 'bot_token', label: 'Discord bot token', envName: 'DISCORD_BOT_TOKEN' }],
  slack: [
    { key: 'bot_token', label: 'Slack bot token (xoxb-…)', envName: 'SLACK_BOT_TOKEN' },
    { key: 'app_token', label: 'Slack app-level token (xapp-…)', envName: 'SLACK_APP_TOKEN' },
  ],
}

/** Where the owner finds their own id on each app. */
export const SETUP_OWNER_HINTS: Record<SetupChannel, string> = {
  telegram: 'Your numeric Telegram user id (message @userinfobot to see it).',
  discord: 'Your numeric Discord user id (Settings → Advanced → Developer Mode, then right-click your name → Copy User ID).',
  slack: 'Your Slack member id, e.g. U012ABCDEF (your profile → ⋯ → Copy member ID).',
}

/** One PASS/WARN/FAIL line, shown verbatim (the CLI already redacts). */
export interface SetupCheck {
  group: string
  status: string
  detail: string
  fixes?: string[]
}

/** The binding line's parts (E33 G6). */
export interface SetupBinding {
  channel: string
  /** The validated bot username, no "@"; absent = not validated. */
  bot?: string
  /** "@bot", the account to message. */
  handle?: string
  /** Discord: adds the bot to a server. */
  invite_url?: string
  humanoid: string
  allowlist: string[]
  session: string
  dir: string
  line: string
}

export interface SetupLink {
  label: string
  url: string
}

export interface SetupStepsReply {
  version: number
  ok: boolean
  error?: string
  channel?: string
  steps: string[]
  /** Slack: the app manifest YAML to paste into "create from manifest". */
  manifest?: string
  links?: SetupLink[]
}

export interface SetupReply {
  version: number
  ok: boolean
  error?: string
  dir?: string
  session?: string
  channel?: string
  checks: SetupCheck[]
  binding?: SetupBinding
  /** verify: true once a real message from the owner made the round trip. */
  verified?: boolean
  /** --store-secrets: the names written to .rysh/secrets (never values). */
  stored_secrets?: string[]
  fails?: number
}

/** hold's reply: a one-time handle for apply. */
export interface SetupHoldReply {
  ok: boolean
  error?: string
  /** Main holds the credentials under this handle until apply; the renderer never gets them back. */
  handle?: string
}

export interface SetupBindingsReply {
  version: number
  ok: boolean
  error?: string
  bindings: SetupBinding[]
}

export interface RemoteSetupAPI {
  steps: (channel: SetupChannel) => Promise<SetupStepsReply>
  /** Sends the credentials once; they are held in main and never returned. rysh setup checks them on apply. */
  hold: (channel: SetupChannel, creds: Record<string, string>) => Promise<SetupHoldReply>
  /** Checks the credentials, writes the profile and starts the assistant: one rysh setup run. */
  apply: (handle: string, owner: string) => Promise<SetupReply>
  verify: (channel: SetupChannel) => Promise<SetupReply>
  bindings: () => Promise<SetupBindingsReply>
  cancel: () => Promise<void>
}
