import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FaceTimePanel } from './FaceTimePanel'

const contacts = [
  { id: 'a', name: 'Alex', addresses: [
    { id: 'email', label: 'work', kind: 'email', value: 'a@example.invalid' },
    { id: 'phone', label: 'mobile', kind: 'phone', value: '+15555550100' },
  ] },
  { id: 'b', name: 'Zoë', addresses: [] },
]
const api = { contacts: vi.fn(), call: vi.fn(), cancel: vi.fn(), doctor: vi.fn() }
beforeEach(() => {
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.setAttribute('open', '') })
  api.contacts.mockResolvedValue({ version: 1, contacts })
  api.call.mockResolvedValue({ version: 1, opened: true })
  api.cancel.mockResolvedValue(undefined)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { facetime: api } })
})
describe('FaceTime contacts panel', () => {
  it('requires loading, contact selection and explicit address selection before calling', async () => {
    render(<FaceTimePanel onClose={() => {}} />)
    expect(api.contacts).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Load contacts'))
    fireEvent.click(await screen.findByRole('button', { name: /Alex/ }))
    const call = screen.getByRole('button', { name: 'Call audio' })
    expect(call).toBeDisabled()
    expect(api.call).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'mobile: +15555550100' }))
    fireEvent.click(call)
    fireEvent.click(call)
    await screen.findByText('Opened FaceTime audio. Use the Apple call window for controls.')
    expect(api.call).toHaveBeenCalledTimes(1)
    expect(api.call).toHaveBeenCalledWith('a', 'phone', '+15555550100')
  })
  it('does not call contacts with no address and clears contacts on permission failure', async () => {
    render(<FaceTimePanel onClose={() => {}} />)
    fireEvent.click(screen.getByText('Load contacts'))
    fireEvent.click(await screen.findByRole('button', { name: /Zoë/ }))
    expect(screen.getByRole('button', { name: 'Call audio' })).toBeDisabled()
    api.contacts.mockResolvedValue({ version: 1, error: 'Permission denied' })
    fireEvent.click(screen.getByText('Search / refresh'))
    await screen.findByText('Permission denied')
    expect(screen.queryByRole('button', { name: /Zoë/ })).toBeNull()
    expect(api.call).not.toHaveBeenCalled()
  })
  it('reports cancellation without claiming a call was opened and cancels on close', async () => {
    api.call.mockResolvedValue({ version: 1, opened: false })
    const { unmount } = render(<FaceTimePanel onClose={() => {}} />)
    fireEvent.click(screen.getByText('Load contacts'))
    fireEvent.click(await screen.findByRole('button', { name: /Alex/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'work: a@example.invalid' }))
    fireEvent.click(screen.getByRole('button', { name: 'Call audio' }))
    await screen.findByText('Call canceled.')
    unmount()
    expect(api.cancel).toHaveBeenCalled()
  })
  it('searches and pages using the bridge without sending daemon commands', async () => {
    api.contacts.mockResolvedValue({ version: 1, contacts, nextOffset: 50 })
    render(<FaceTimePanel onClose={() => {}} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search contacts' }), { target: { value: 'Zoë' } })
    fireEvent.click(screen.getByText('Load contacts'))
    await screen.findByRole('button', { name: /Zoë/ })
    fireEvent.click(screen.getByText('Next page'))
    await waitFor(() => expect(api.contacts).toHaveBeenLastCalledWith('Zoë', 50))
  })
})
