import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteSetupView } from './RemoteSetupView'

// Synthetic values only; anything compared against a token is a boolean, so a
// failing test names itself, never the value.
const FAKE_TOKEN = 'fake-telegram-token-for-tests-only'
const LINE = 'telegram @my_bot → assistant (owner 42) → session work in /w; drives panes via pane_send'
const binding = { channel: 'telegram', bot: 'my_bot', handle: '@my_bot', humanoid: 'assistant', allowlist: ['42'], session: 'work', dir: '/w', line: LINE }

const api = { steps: vi.fn(), hold: vi.fn(), apply: vi.fn(), verify: vi.fn(), bindings: vi.fn(), cancel: vi.fn() }
beforeEach(() => {
  vi.clearAllMocks()
  api.steps.mockImplementation(async (channel: string) => ({ version: 1, ok: true, channel, steps: [`1. ${channel} step one`, `2. ${channel} step two`] }))
  api.hold.mockResolvedValue({ ok: true, handle: 'h-1' })
  api.apply.mockResolvedValue({ version: 1, ok: true, checks: [{ group: 'channel', status: 'PASS', detail: 'telegram — credentials valid (@my_bot)' }], binding })
  api.verify.mockResolvedValue({ version: 1, ok: true, verified: true, checks: [{ group: 'verify', status: 'PASS', detail: 'VERIFIED round trip' }], binding })
  api.cancel.mockResolvedValue(undefined)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { remoteSetup: api } })
})

async function toTokenStep(channel: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: channel }))
  fireEvent.click(await screen.findByRole('button', { name: 'I have the token' }))
}

async function startWith(label: string, channel: RegExp) {
  await toTokenStep(channel)
  fireEvent.change(screen.getByLabelText(label), { target: { value: FAKE_TOKEN } })
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.change(await screen.findByLabelText(/user id/), { target: { value: '42' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start' }))
}

describe('Set up remote access', () => {
  it('offers Telegram, then Discord, then Slack (founder ruling Q2)', () => {
    render(<RemoteSetupView onClose={() => {}} />)
    const names = screen.getAllByRole('button').map((b) => b.textContent).filter((t) => t !== 'Close')
    expect(names).toEqual(['Telegram (quickest)', 'Discord', 'Slack'])
  })

  it('shows the numbered bot-creation steps from rysh setup', async () => {
    render(<RemoteSetupView onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Telegram/ }))
    expect(await screen.findByText('1. telegram step one')).toBeInTheDocument()
    expect(api.steps).toHaveBeenCalledWith('telegram')
  })

  it('Slack: shows the manifest with a copy button and the create-from-manifest link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    api.steps.mockResolvedValueOnce({ version: 1, ok: true, steps: ['1. create from manifest'], manifest: 'display_information:\n  name: rysh\n',
      links: [{ label: 'Create from manifest', url: 'https://api.slack.com/apps?new_app=1' }] })
    render(<RemoteSetupView onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Slack' }))
    expect((await screen.findByLabelText('app manifest')).textContent).toBe('display_information:\n  name: rysh\n')
    fireEvent.click(screen.getByRole('button', { name: 'Copy manifest' }))
    expect(writeText).toHaveBeenCalledWith('display_information:\n  name: rysh\n')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create from manifest' })).toHaveAttribute('href', 'https://api.slack.com/apps?new_app=1')
    fireEvent.click(screen.getByRole('button', { name: 'I have the token' }))
    expect(screen.getAllByLabelText(/token/)).toHaveLength(2)
  })

  it('takes the token in a password field, sends it once and clears it on submit', async () => {
    let resolve: (v: unknown) => void = () => {}
    api.hold.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const { container } = render(<RemoteSetupView onClose={() => {}} />)
    await toTokenStep(/Telegram/)
    const field = screen.getByLabelText('Telegram bot token') as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: FAKE_TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(api.hold).toHaveBeenCalledTimes(1)
    expect(api.hold.mock.calls[0][0]).toBe('telegram')
    expect(api.hold.mock.calls[0][1].bot_token === FAKE_TOKEN).toBe(true)
    // Cleared before the reply arrives.
    expect(field.value === '').toBe(true)
    resolve({ ok: true, handle: 'h-1' })
    expect(await screen.findByLabelText(/Telegram user id/)).toBeInTheDocument()
    expect(container.innerHTML.includes(FAKE_TOKEN)).toBe(false)
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('shows a FAIL from rysh setup verbatim with its fix and goes back to the token step', async () => {
    api.apply.mockResolvedValueOnce({ version: 1, ok: false, error: 'setup saved, but 1 check(s) FAILed', checks: [
      { group: 'channel', status: 'FAIL', detail: 'telegram: getMe: 401 Unauthorized', fixes: ['##secret new TELEGRAM_BOT_TOKEN'] }] })
    render(<RemoteSetupView onClose={() => {}} />)
    await startWith('Telegram bot token', /Telegram/)
    expect(await screen.findByText('telegram: getMe: 401 Unauthorized')).toBeInTheDocument()
    expect(screen.getByText('fix: ##secret new TELEGRAM_BOT_TOKEN')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('1 check(s) FAILed')
    expect((screen.getByLabelText('Telegram bot token') as HTMLInputElement).value === '').toBe(true)
  })

  it('names the bot after start, and for Discord shows the invite URL from the validated application id', async () => {
    api.apply.mockResolvedValueOnce({ version: 1, ok: true, checks: [],
      binding: { ...binding, channel: 'discord', invite_url: 'https://discord.com/oauth2/authorize?client_id=1&scope=bot' } })
    render(<RemoteSetupView onClose={() => {}} />)
    await startWith('Discord bot token', /Discord/)
    expect(await screen.findByText(/Your bot is @my_bot/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'invite the bot' })).toHaveAttribute('href', 'https://discord.com/oauth2/authorize?client_id=1&scope=bot')
  })

  it('owner id → start → round-trip verify → binding card', async () => {
    const onDone = vi.fn()
    render(<RemoteSetupView onClose={() => {}} onDone={onDone} />)
    await startWith('Telegram bot token', /Telegram/)
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith('h-1', '42'))
    expect(await screen.findByText(/send a message to @my_bot/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check round trip' }))
    expect(await screen.findByLabelText('binding')).toHaveTextContent(LINE)
    expect(api.verify).toHaveBeenCalledWith('telegram')
    expect(onDone).toHaveBeenCalledWith(binding)
  })

  it('a round trip that has not arrived says so and keeps the verify step', async () => {
    api.verify.mockResolvedValueOnce({ version: 1, ok: false, verified: false, checks: [{ group: 'verify', status: 'WARN', detail: 'no message within 300s' }] })
    render(<RemoteSetupView onClose={() => {}} />)
    await startWith('Telegram bot token', /Telegram/)
    fireEvent.click(await screen.findByRole('button', { name: 'Check round trip' }))
    expect(await screen.findByText('no message within 300s')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check round trip' })).toBeInTheDocument()
    expect(screen.queryByLabelText('binding')).toBeNull()
  })

  it('a failed start goes back to the token step (the held token is spent)', async () => {
    api.apply.mockResolvedValueOnce({ version: 1, ok: false, error: 'setup saved, but 1 check(s) FAILed', checks: [{ group: 'daemon', status: 'FAIL', detail: 'daemon not running' }] })
    render(<RemoteSetupView onClose={() => {}} />)
    await startWith('Telegram bot token', /Telegram/)
    expect(await screen.findByText('daemon not running')).toBeInTheDocument()
    expect((screen.getByLabelText('Telegram bot token') as HTMLInputElement).value === '').toBe(true)
  })

  it('cancels a running step when closed, and explains itself outside the desktop app', () => {
    const { unmount } = render(<RemoteSetupView onClose={() => {}} />)
    unmount()
    expect(api.cancel).toHaveBeenCalled()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
    render(<RemoteSetupView onClose={() => {}} />)
    expect(screen.getByText(/In a terminal, run: rysh setup/)).toBeInTheDocument()
  })
})
