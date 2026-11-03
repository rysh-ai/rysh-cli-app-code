import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store'
import { ChannelsView } from './ChannelsView'

const LINE = 'telegram @my_bot → assistant (owner 42) → session work in /w; drives panes via pane_send'
const binding = { channel: 'telegram', bot: 'my_bot', humanoid: 'assistant', allowlist: ['42'], session: 'work', dir: '/w', line: LINE }
const api = { steps: vi.fn(), hold: vi.fn(), apply: vi.fn(), verify: vi.fn(), bindings: vi.fn(), cancel: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  api.bindings.mockResolvedValue({ version: 1, ok: true, bindings: [binding] })
  api.steps.mockResolvedValue({ version: 1, ok: true, steps: ['1. open @BotFather'] })
  api.cancel.mockResolvedValue(undefined)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { remoteSetup: api } })
  useStore.setState({
    controlEnabled: false,
    humanoidList: [{ name: 'assistant', active: true, system_prompt: '', channels: [
      { type: 'telegram', connected: true, details: 'polling' },
      { type: 'slack', connected: false },
    ] }],
  })
})

describe('Channels view', () => {
  it('opens "Set up remote access" from the dashboard', async () => {
    render(<ChannelsView />)
    fireEvent.click(screen.getByRole('button', { name: 'Set up remote access' }))
    expect(screen.getByRole('region', { name: 'Set up remote access' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Telegram/ }))
    expect(await screen.findByText('1. open @BotFather')).toBeInTheDocument()
  })

  it('shows the binding line for each configured channel, from rysh setup --status', async () => {
    render(<ChannelsView />)
    expect(await screen.findByText(LINE)).toBeInTheDocument()
    expect(api.bindings).toHaveBeenCalledTimes(1)
    // A channel the CLI reports no binding for gets the placeholder, not a guess.
    expect(screen.getByText('binding: not set up yet — use Set up remote access')).toBeInTheDocument()
  })

  it('keeps a placeholder when this rysh cannot report bindings yet', async () => {
    api.bindings.mockResolvedValue({ version: 1, ok: false, error: 'This rysh has no headless setup yet', bindings: [] })
    render(<ChannelsView />)
    expect(await screen.findAllByText('binding: not reported by this rysh yet')).toHaveLength(2)
  })

  it('offers setup even with no humanoids registered yet', () => {
    useStore.setState({ humanoidList: [] })
    render(<ChannelsView />)
    expect(screen.getByText('No humanoids registered')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set up remote access' })).toBeInTheDocument()
  })

  it('shows no binding line in the web UI, where the CLI cannot be asked', () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
    render(<ChannelsView />)
    expect(screen.queryByText(/^binding:/)).toBeNull()
    expect(screen.getByText('telegram')).toBeInTheDocument()
  })
})
