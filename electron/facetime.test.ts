// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
const handlers = new Map<string, (...args: any[]) => any>()
const state = vi.hoisted(() => ({ exec: vi.fn(), handle: vi.fn(), remove: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: state.handle, removeHandler: state.remove } }))
vi.mock('node:child_process', () => ({ execFile: state.exec }))
import { registerFaceTimeHandlers } from './facetime'
import { callRequest, contactsRequest, decodeReply } from './facetimeService'

beforeEach(() => { vi.unstubAllGlobals(); handlers.clear(); vi.clearAllMocks(); state.handle.mockImplementation((name, handler) => handlers.set(name, handler)) })
describe('FaceTime IPC', () => {
  function setup() {
    const frame = { url: 'file:///app/index.html' }
    const contents = { mainFrame: frame, on: vi.fn() }
    const win = { isDestroyed: () => false, webContents: contents, on: vi.fn() }
    registerFaceTimeHandlers(win as any, frame.url, () => '/bundled/rysh')
    return { win, frame, contents, event: { sender: contents, senderFrame: frame } }
  }
  it('rejects web panes, subframes and navigation before invoking the helper', () => {
    const { frame, contents } = setup()
    for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: { url: frame.url } }]) {
      expect(() => handlers.get('facetime-contacts')!(event, '')).toThrow(/desktop window/)
    }
    frame.url = 'https://evil.invalid/'
    expect(() => handlers.get('facetime-doctor')!({ sender: contents, senderFrame: frame })).toThrow()
    expect(state.exec).not.toHaveBeenCalled()
  })
  it('validates requests before starting a process', () => {
    const { event } = setup()
    expect(() => handlers.get('facetime-contacts')!(event, {}, 0)).toThrow()
    expect(() => handlers.get('facetime-call')!(event, 'a', 'b', '\n')).toThrow()
    expect(state.exec).not.toHaveBeenCalled()
  })
  it('passes structured data on stdin and suppresses concurrent calls', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    const { event } = setup()
    let complete: (...args: any[]) => void = () => {}
    const child = { stdin: { end: vi.fn(), on: vi.fn() }, kill: vi.fn() }
    state.exec.mockImplementation((_file, _args, _options, callback) => { complete = callback; return child })
    const pending = handlers.get('facetime-call')!(event, 'c', 'a', 'a@example.invalid')
    expect(state.exec.mock.calls[0].slice(0, 2)).toEqual(['/bundled/rysh', ['facetime', 'bridge']])
    expect(JSON.parse(child.stdin.end.mock.calls[0][0])).toMatchObject({ operation: 'call', contactID: 'c', addressID: 'a' })
    const busy = await handlers.get('facetime-call')!(event, 'c', 'a', 'a@example.invalid')
    expect(busy.error).toMatch(/Finish or cancel/)
    expect(state.exec).toHaveBeenCalledTimes(1)
    handlers.get('facetime-cancel')!(event)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    complete(null, '{"version":1,"opened":false}')
    expect((await pending).opened).toBe(false)
    vi.unstubAllGlobals()
  })
  it('returns an unsupported platform result without running a process', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const { event } = setup()
    expect((await handlers.get('facetime-doctor')!(event)).code).toBe('unsupported_platform')
    expect(state.exec).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('removes handlers when the main window closes so it can reopen', () => {
    const { win } = setup()
    win.on.mock.calls.find(([name]) => name === 'closed')![1]()
    expect(state.remove.mock.calls.map(([name]) => name)).toEqual([
      'facetime-doctor', 'facetime-contacts', 'facetime-call', 'facetime-cancel',
    ])
  })
  it('enforces limits and response version'  , () => {
    expect(() => contactsRequest('', -1)).toThrow()
    expect(() => contactsRequest('é'.repeat(129))).toThrow()
    expect(() => callRequest('', 'a', 'value')).toThrow()
    expect(() => decodeReply('{"version":2}')).toThrow()
    expect(contactsRequest('Zoë', 50)).toMatchObject({ search: 'Zoë', offset: 50, limit: 50 })
  })
})
