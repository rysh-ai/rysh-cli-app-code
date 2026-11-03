import { useEffect, useRef, useState } from 'react'
import {
  SETUP_CHANNEL_LABELS, SETUP_CHANNEL_ORDER, SETUP_CRED_FIELDS, SETUP_OWNER_HINTS,
  type SetupBinding, type SetupChannel, type SetupCheck, type SetupLink,
} from '../types/remoteSetup'

/**
 * E33 slice C — "Set up remote access": the same steps as `rysh setup`, driven
 * through the desktop app's main process (window.electronAPI.remoteSetup), which
 * runs the bundled rysh headless. Channel → bot-creation steps → token → owner
 * id → start (rysh setup checks the token, writes the profile, starts the
 * assistant, names @your_bot) → round-trip verify → binding card.
 *
 * Tokens live only in this component's state between typing and "Next": the
 * value goes once over IPC to main, and the state is cleared before it answers.
 * Nothing here logs, stores or renders a token.
 */

type Stage = 'channel' | 'steps' | 'token' | 'owner' | 'verify' | 'done'

const STATUS_COLOR: Record<string, string> = { PASS: '#87ff87', OK: '#87ff87', WARN: '#ffd75f', FAIL: '#ff5f5f' }

function Checks({ checks }: { checks: SetupCheck[] }) {
  if (checks.length === 0) return null
  return (
    <ul className="flex flex-col gap-0.5 text-[11px] font-mono" aria-label="setup checks">
      {checks.map((c, i) => (
        <li key={i}>
          <span style={{ color: STATUS_COLOR[c.status] ?? '#d4d4d4' }}>{c.status}</span>{' '}
          <span className="text-[#808080]">{c.group}</span>{' '}
          <span className="text-[#d4d4d4]">{c.detail}</span>
          {c.fixes?.map((f, j) => <div key={j} className="pl-6 text-[#aaa]">fix: {f}</div>)}
        </li>
      ))}
    </ul>
  )
}

function ExternalLink({ link }: { link: SetupLink }) {
  // target=_blank goes through the main window's open handler → default browser.
  return <a href={link.url} target="_blank" rel="noreferrer" className="text-[#87afff] underline">{link.label}</a>
}

function botFrom(binding?: SetupBinding): string {
  return binding?.bot ? `@${binding.bot}` : ''
}

const btn = 'px-2 py-0.5 rounded text-[11px] bg-[#005f5f] text-[#87ffff] hover:bg-[#008080] disabled:opacity-40'
const input = 'bg-[#1a1a1a] border border-[#444] rounded text-[#d4d4d4] text-[12px] px-2 py-1 outline-none w-full'

export function RemoteSetupView({ onClose, onDone }: { onClose: () => void; onDone?: (binding: SetupBinding) => void }) {
  const api = window.electronAPI?.remoteSetup
  const [stage, setStage] = useState<Stage>('channel')
  const [channel, setChannel] = useState<SetupChannel>('telegram')
  const [steps, setSteps] = useState<string[]>([])
  const [manifest, setManifest] = useState('')
  const [links, setLinks] = useState<SetupLink[]>([])
  const [creds, setCreds] = useState<Record<string, string>>({})
  const [handle, setHandle] = useState('')
  const [bot, setBot] = useState('')
  const [invite, setInvite] = useState('')
  const [owner, setOwner] = useState('')
  const [binding, setBinding] = useState<SetupBinding>()
  const [checks, setChecks] = useState<SetupCheck[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; void api?.cancel().catch(() => {}) }
  }, [api])

  if (!api) {
    return <p className="text-[12px] text-[#888] italic">Remote setup runs in the Rysh desktop app. In a terminal, run: rysh setup</p>
  }

  // One step at a time; a reply that arrives after unmount is dropped.
  async function step<T>(call: () => Promise<T>, then: (r: T) => void) {
    if (busy) return
    setBusy(true); setError(''); setChecks([])
    try {
      const r = await call()
      if (alive.current) then(r)
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'rysh setup could not run.')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  function pick(ch: SetupChannel) {
    setChannel(ch); setCreds({}); setHandle(''); setBot(''); setInvite(''); setBinding(undefined)
    void step(() => api!.steps(ch), (r) => {
      setSteps(r.steps ?? []); setManifest(r.manifest ?? ''); setLinks(r.links ?? [])
      if (!r.ok) setError(r.error ?? 'Could not load the steps.')
      setStage('steps')
    })
  }

  function submitCreds() {
    const submitted = creds
    setCreds({}) // cleared on submit: the value is now only in flight to main
    void step(() => api!.hold(channel, submitted), (r) => {
      if (r.ok && r.handle) { setHandle(r.handle); setStage('owner') }
      else setError(r.error ?? 'Paste the token again.')
    })
  }

  function start() {
    void step(() => api!.apply(handle, owner), (r) => {
      setChecks(r.checks ?? [])
      setHandle('')
      if (r.binding) { setBinding(r.binding); setBot(botFrom(r.binding)); setInvite(r.binding.invite_url ?? '') }
      if (r.ok) setStage('verify')
      else { setError(r.error ?? 'Setup did not finish.'); setStage('token') }
    })
  }

  function verify() {
    void step(() => api!.verify(channel), (r) => {
      setChecks(r.checks ?? [])
      if (r.binding) setBinding(r.binding)
      if (r.ok && r.verified) finish(r.binding ?? binding)
      else setError(r.error ?? 'No message arrived yet. Send one to your bot, then check again.')
    })
  }

  function finish(b?: SetupBinding) {
    setStage('done')
    if (b) onDone?.(b)
  }

  const fields = SETUP_CRED_FIELDS[channel]
  const label = SETUP_CHANNEL_LABELS[channel]
  const credsComplete = fields.every((f) => (creds[f.key] ?? '').trim() !== '')

  return (
    <section aria-label="Set up remote access" className="border border-[#5f5f87] rounded bg-[#1e1e1e] p-3 flex flex-col gap-2 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="font-bold text-[#ffffaf] text-[13px]">Set up remote access</span>
        {stage !== 'channel' && <span className="text-[#808080]">{label}</span>}
        <span className="flex-1" />
        <button onClick={onClose} className="text-[#888] hover:text-[#fff] text-[11px]">Close</button>
      </div>

      {stage === 'channel' && (
        <>
          <p className="text-[#aaa]">Talk to your agent from your phone. Pick the chat app:</p>
          <div className="flex gap-2" role="group" aria-label="chat app">
            {SETUP_CHANNEL_ORDER.map((ch, i) => (
              <button key={ch} className={btn} disabled={busy} onClick={() => pick(ch)}>
                {SETUP_CHANNEL_LABELS[ch]}{i === 0 ? ' (quickest)' : ''}
              </button>
            ))}
          </div>
        </>
      )}

      {stage === 'steps' && (
        <>
          <p className="text-[#aaa]">Create your {label} bot:</p>
          <ol className="flex flex-col gap-0.5 text-[#d4d4d4]" aria-label="bot steps">
            {steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          {manifest && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[#aaa]">App manifest</span>
                <button
                  className={btn}
                  onClick={() => { void navigator.clipboard?.writeText(manifest).then(() => alive.current && setCopied(true), () => {}) }}
                >
                  {copied ? 'Copied' : 'Copy manifest'}
                </button>
              </div>
              <pre aria-label="app manifest" className="bg-[#141414] border border-[#333] rounded p-2 text-[10px] text-[#bbb] max-h-40 overflow-auto">{manifest}</pre>
            </div>
          )}
          {links.length > 0 && <div className="flex flex-wrap gap-3">{links.map((l) => <ExternalLink key={l.url} link={l} />)}</div>}
          <div className="flex gap-2">
            <button className={btn} onClick={() => setStage('channel')}>Back</button>
            <button className={btn} onClick={() => { setError(''); setStage('token') }}>I have the token</button>
          </div>
        </>
      )}

      {stage === 'token' && (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (credsComplete) submitCreds() }}>
          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-0.5 text-[#aaa]">
              {f.label}
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                className={input}
                value={creds[f.key] ?? ''}
                onChange={(e) => { const v = e.target.value; setCreds((c) => ({ ...c, [f.key]: v })) }}
              />
            </label>
          ))}
          <p className="text-[10px] text-[#666]">Stored by rysh in .rysh/secrets in this project once the check passes; the profile only names it.</p>
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={() => { setCreds({}); setStage('steps') }}>Back</button>
            <button type="submit" className={btn} disabled={busy || !credsComplete}>Next</button>
          </div>
        </form>
      )}

      {stage === 'owner' && (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (owner.trim()) start() }}>
          <label className="flex flex-col gap-0.5 text-[#aaa]">
            Your {label} user id — the only sender the assistant answers
            <input className={input} value={owner} onChange={(e) => setOwner(e.target.value)} />
          </label>
          <p className="text-[10px] text-[#666]">{SETUP_OWNER_HINTS[channel]}</p>
          <p className="text-[10px] text-[#666]">Start checks the token with {label}, writes the assistant profile and starts it.</p>
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={() => { setHandle(''); setStage('token') }}>Back</button>
            <button type="submit" className={btn} disabled={busy || !owner.trim()}>{busy ? 'Checking and starting…' : 'Start'}</button>
          </div>
        </form>
      )}

      {stage === 'verify' && (
        <>
          {bot && <p className="text-[#87ff87]">Your bot is {bot} — that is who you will message from your phone.</p>}
          {invite && <p className="text-[#aaa]">Add it to your server: <ExternalLink link={{ label: 'invite the bot', url: invite }} /></p>}
          <p className="text-[#d4d4d4]">Now send a message to {bot || 'your bot'} from your phone, then check the round trip.</p>
          <div className="flex gap-2">
            <button className={btn} disabled={busy} onClick={verify}>{busy ? 'Waiting for your message…' : 'Check round trip'}</button>
            <button className={btn} disabled={busy} onClick={() => finish(binding)}>Skip</button>
          </div>
        </>
      )}

      {stage === 'done' && (
        <div aria-label="binding" className="border border-[#333] rounded bg-[#141414] p-2 font-mono text-[11px] text-[#87ffff]">
          {binding?.line ?? `${channel} ${bot} → assistant (owner ${owner})`}
        </div>
      )}

      {error && <p role="alert" className="text-[#ff5f5f] text-[11px]">{error}</p>}
      <Checks checks={checks} />
    </section>
  )
}
