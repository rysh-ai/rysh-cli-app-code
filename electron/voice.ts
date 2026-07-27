import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Voice prompting support for the desktop app.
 *
 * Mirrors the rysh-cli TUI voice feature (3f3d182): the renderer records the
 * microphone, the audio is transcribed via Deepgram (default) or OpenAI
 * Whisper, and the transcript is dropped into the active pane's input field.
 *
 * Transcription runs in the MAIN process (not the renderer) so the HTTP calls
 * to api.deepgram.com / api.openai.com are not subject to browser CORS, and the
 * API key never has to live in the renderer.
 *
 * Configuration mirrors the sidecar's keys (single source of truth): the
 * [voice_control] (tts_provider_name, api_key) and [voice] (enabled, language,
 * hotkey) sections of rysh.config, with RYSH_VOICE_* environment overrides.
 */

export interface VoiceConfigPublic {
  enabled: boolean
  provider: string // "deepgram" | "whisper"
  hotkey: string // Bubble Tea-style key string, e.g. "ctrl+r"
  language: string
}

interface VoiceConfigFull extends VoiceConfigPublic {
  apiKey: string
}

// Parse the simple "[section] key = value" structure of rysh.config. We only
// need a handful of known keys, so a light scanner avoids a TOML dependency.
function parseConfigSections(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let current = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sec = line.match(/^\[([^\]]+)\]$/)
    if (sec) {
      current = sec[1]
      sections[current] = sections[current] || {}
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/)
    if (kv && current) {
      let v = kv[2].trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1)
      }
      sections[current][kv[1]] = v
    }
  }
  return sections
}

// Parse the nested "section:\n  key: value" YAML structure of
// rysh.config.yaml for the handful of keys we need (avoids a YAML dependency).
function parseYamlSections(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let current = ''
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    // Top-level section header: "voice_control:" (no value on the line).
    const sec = raw.match(/^([A-Za-z0-9_-]+):\s*(#.*)?$/)
    if (sec) {
      current = sec[1]
      sections[current] = sections[current] || {}
      continue
    }
    // Indented "key: value" under the current section.
    const kv = raw.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/)
    if (kv && current) {
      sections[current][kv[1]] = stripYamlValue(kv[2])
    }
  }
  return sections
}

function stripYamlValue(v: string): string {
  v = v.trim()
  if (v.startsWith('"')) {
    const e = v.indexOf('"', 1)
    return e >= 0 ? v.slice(1, e) : v.slice(1)
  }
  if (v.startsWith("'")) {
    const e = v.indexOf("'", 1)
    return e >= 0 ? v.slice(1, e) : v.slice(1)
  }
  // Unquoted scalar: strip a trailing inline comment ("  # ...").
  const hash = v.indexOf(' #')
  if (hash >= 0) v = v.slice(0, hash)
  return v.trim()
}

// Locate the rysh config. The daemon switched to rysh.config.yaml (YAML); we
// prefer it but keep the legacy rysh.config (TOML) as a fallback.
function findConfigFile(workspaceDir?: string): string | null {
  const names = ['rysh.config.yaml', 'rysh.config.yml', 'rysh.config']
  const dirs: string[] = []
  if (workspaceDir) dirs.push(workspaceDir)
  dirs.push(process.cwd())
  dirs.push(join(homedir(), '.config', 'rysh'))
  for (const d of dirs) {
    for (const n of names) {
      const c = join(d, n)
      try {
        if (existsSync(c)) return c
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

export function readVoiceConfig(workspaceDir?: string): VoiceConfigFull {
  let enabled = false
  let provider = 'deepgram'
  let hotkey = 'ctrl+r'
  let language = ''
  let apiKey = ''

  const file = findConfigFile(workspaceDir)
  if (file) {
    try {
      const text = readFileSync(file, 'utf8')
      const isYaml = file.endsWith('.yaml') || file.endsWith('.yml')
      const sections = isYaml ? parseYamlSections(text) : parseConfigSections(text)
      const vc = sections['voice_control'] || {}
      const v = sections['voice'] || {}
      if (vc['tts_provider_name']) provider = vc['tts_provider_name']
      if (vc['api_key']) apiKey = vc['api_key']
      if (v['enabled'] != null) enabled = v['enabled'] === 'true'
      if (v['language']) language = v['language']
      if (v['hotkey']) hotkey = v['hotkey']
    } catch {
      /* ignore malformed config */
    }
  }

  const env = process.env
  if (env.RYSH_VOICE_PROVIDER) provider = env.RYSH_VOICE_PROVIDER
  if (env.RYSH_VOICE_API_KEY) apiKey = env.RYSH_VOICE_API_KEY
  if (env.RYSH_VOICE_LANGUAGE) language = env.RYSH_VOICE_LANGUAGE
  if (env.RYSH_VOICE_HOTKEY) hotkey = env.RYSH_VOICE_HOTKEY
  if (env.RYSH_VOICE_ENABLED != null) {
    enabled = env.RYSH_VOICE_ENABLED === 'true' || env.RYSH_VOICE_ENABLED === '1'
  }

  // If a key is configured, treat voice as usable even if [voice].enabled was
  // not explicitly set (matches "configure the key and it works").
  if (apiKey) enabled = true

  return { enabled, provider, hotkey, language, apiKey }
}

export function publicVoiceConfig(c: VoiceConfigFull): VoiceConfigPublic {
  return {
    enabled: c.enabled && !!c.apiKey,
    provider: c.provider,
    hotkey: c.hotkey,
    language: c.language,
  }
}

// fetch / FormData / Blob are Node 20 globals (Electron 31) but not declared by
// the main tsconfig's "ES2022" lib, so reach them through globalThis.
const g = globalThis as unknown as {
  fetch: (input: string, init?: unknown) => Promise<{
    ok: boolean
    status: number
    text: () => Promise<string>
    json: () => Promise<unknown>
  }>
  FormData: { new (): { append: (k: string, v: unknown, filename?: string) => void } }
  Blob: { new (parts: unknown[], opts?: { type?: string }): unknown }
}

export async function transcribeAudio(
  audio: ArrayBuffer,
  mimeType: string,
  workspaceDir?: string
): Promise<{ transcript?: string; error?: string }> {
  const cfg = readVoiceConfig(workspaceDir)
  if (!cfg.apiKey) {
    return {
      error:
        'voice: no API key configured (set [voice_control].api_key in rysh.config or RYSH_VOICE_API_KEY)',
    }
  }
  const bytes = new Uint8Array(audio)
  const provider = (cfg.provider || 'deepgram').toLowerCase()
  try {
    if (provider === 'whisper' || provider === 'openai') {
      return await transcribeWhisper(bytes, mimeType, cfg)
    }
    return await transcribeDeepgram(bytes, mimeType, cfg)
  } catch (err) {
    return { error: `voice: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function transcribeDeepgram(
  bytes: Uint8Array,
  mimeType: string,
  cfg: VoiceConfigFull
): Promise<{ transcript?: string; error?: string }> {
  const params = new URLSearchParams({ model: 'nova-3', smart_format: 'true' })
  if (cfg.language) params.set('language', cfg.language)
  const url = `https://api.deepgram.com/v1/listen?${params.toString()}`
  const resp = await g.fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${cfg.apiKey}`,
      'Content-Type': mimeType || 'audio/webm',
    },
    body: bytes,
  })
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    return { error: `deepgram ${resp.status}: ${t.slice(0, 200)}` }
  }
  const data = (await resp.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] }
  }
  const transcript =
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
  return { transcript: String(transcript).trim() }
}

async function transcribeWhisper(
  bytes: Uint8Array,
  mimeType: string,
  cfg: VoiceConfigFull
): Promise<{ transcript?: string; error?: string }> {
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm'
  const form = new g.FormData()
  form.append('file', new g.Blob([bytes], { type: mimeType || 'audio/webm' }), `audio.${ext}`)
  form.append('model', 'whisper-1')
  if (cfg.language) form.append('language', cfg.language)
  const resp = await g.fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  })
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    return { error: `whisper ${resp.status}: ${t.slice(0, 200)}` }
  }
  const data = (await resp.json()) as { text?: string }
  return { transcript: String(data?.text ?? '').trim() }
}
