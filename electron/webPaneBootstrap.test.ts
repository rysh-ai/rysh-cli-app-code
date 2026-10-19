import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDENTITY_BUDGET_MS, loadWithIdentity, settleWithin, type BootstrapContents } from './webPaneBootstrap'

// E30 PM-4a: on Electron 41 the CDP identity calls never settle on a view that
// has not navigated, and create() awaited them before loadURL — so every new
// web pane stayed blank. The page must load whatever the debugger does.

const never = () => new Promise<void>(() => {})

function fakeContents(opts: { blank?: 'ok' | 'hang' } = {}) {
  const calls: string[] = []
  const listeners = new Set<(e: unknown, url: string) => void>()
  let url = ''
  let destroyed = false
  const c: BootstrapContents & {
    calls: string[]
    commit(u: string): void
    destroy(): void
    cleared: number
    listeners: typeof listeners
  } = {
    calls,
    cleared: 0,
    listeners,
    getURL: () => url,
    loadURL: (u: string) => {
      calls.push(`load ${u}`)
      if (u === 'about:blank' && opts.blank === 'hang') return never()
      url = u
      return Promise.resolve()
    },
    on: (_ev, l) => listeners.add(l),
    removeListener: (_ev, l) => listeners.delete(l),
    navigationHistory: {
      clear: () => {
        c.cleared++
      },
    },
    isDestroyed: () => destroyed,
    commit(u: string) {
      for (const l of [...listeners]) l({}, u)
    },
    destroy() {
      destroyed = true
    },
  }
  return c
}

afterEach(() => {
  vi.useRealTimers()
})

describe('loadWithIdentity', () => {
  it('primes with about:blank, applies the override, then loads the URL — in that order', async () => {
    const c = fakeContents()
    const override = vi.fn(async () => {
      c.calls.push('override')
    })
    const r = await loadWithIdentity(c, 'https://meet.google.com/abc-defg-hij', override)
    expect(r.identity).toBe('settled')
    expect(c.calls).toEqual(['load about:blank', 'override', 'load https://meet.google.com/abc-defg-hij'])
  })

  it('still loads within the budget when the debugger never answers', async () => {
    vi.useFakeTimers()
    const c = fakeContents()
    const done = loadWithIdentity(c, 'https://example.com', never)
    await vi.advanceTimersByTimeAsync(IDENTITY_BUDGET_MS - 1)
    expect(c.calls).toEqual(['load about:blank'])
    await vi.advanceTimersByTimeAsync(1)
    const r = await done
    expect(r.identity).toBe('timeout')
    expect(c.calls).toEqual(['load about:blank', 'load https://example.com'])
  })

  it('still loads when even the about:blank primer hangs', async () => {
    vi.useFakeTimers()
    const c = fakeContents({ blank: 'hang' })
    const override = vi.fn(async () => {})
    const done = loadWithIdentity(c, 'https://example.com', override)
    await vi.advanceTimersByTimeAsync(IDENTITY_BUDGET_MS)
    expect((await done).identity).toBe('timeout')
    expect(override).not.toHaveBeenCalled()
    expect(c.calls.at(-1)).toBe('load https://example.com')
  })

  it('a failing override is not fatal', async () => {
    const c = fakeContents()
    const r = await loadWithIdentity(c, 'https://example.com', async () => {
      throw new Error('Another debugger is already attached')
    })
    expect(r.identity).toBe('settled')
    expect(c.calls.at(-1)).toBe('load https://example.com')
  })

  it('does not prime a view that already has a page', async () => {
    const c = fakeContents()
    await c.loadURL('https://already.example')
    c.calls.length = 0
    await loadWithIdentity(c, 'https://example.com', async () => {})
    expect(c.calls).toEqual(['load https://example.com'])
    expect(c.listeners.size).toBe(0)
  })

  it('drops the primer from history once the real page commits, so Back never shows about:blank', async () => {
    const c = fakeContents()
    await loadWithIdentity(c, 'https://example.com', async () => {})
    c.commit('about:blank') // a late primer commit is not the real page
    expect(c.cleared).toBe(0)
    c.commit('https://example.com/')
    expect(c.cleared).toBe(1)
    c.commit('https://example.com/next')
    expect(c.cleared).toBe(1)
    expect(c.listeners.size).toBe(0)
  })

  it('does not load into a view closed while the override ran', async () => {
    const c = fakeContents()
    const r = await loadWithIdentity(c, 'https://example.com', async () => {
      c.destroy()
    })
    await r.load
    expect(c.calls).toEqual(['load about:blank'])
  })
})

describe('settleWithin', () => {
  it('reports settled for resolve and reject, timeout for never', async () => {
    expect(await settleWithin(Promise.resolve(1), 10)).toBe('settled')
    expect(await settleWithin(Promise.reject(new Error('x')), 10)).toBe('settled')
    expect(await settleWithin(never(), 10)).toBe('timeout')
  })
})
