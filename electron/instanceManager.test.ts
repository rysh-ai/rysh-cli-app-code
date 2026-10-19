// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' }, dialog: { showErrorBox: () => {} } }))
import { chooseSlot } from './instanceManager'

// E-78: `--instance=7` with slot 7 held fell back to the lowest free slot,
// including 0 — the primary profile — and opened the founder's primary
// workspaces. A launch now only lands on a slot it holds, and never on 0 it
// did not ask for.

/** A claim fake: `held` slots are taken by other instances; records what was tried. */
function claims(held: Iterable<number>) {
  const taken = new Set(held)
  const tried: number[] = []
  const claim = (n: number) => {
    tried.push(n)
    if (taken.has(n)) return false
    taken.add(n)
    return true
  }
  return { claim, tried }
}

const ALL = Array.from({ length: 32 }, (_, i) => i)

describe('chooseSlot --instance=N', () => {
  it('takes N when it is free', () => {
    expect(chooseSlot(['rysh', '--instance=7'], claims([]).claim)).toEqual({ slot: 7 })
    expect(chooseSlot(['rysh', '--instance=0'], claims([]).claim)).toEqual({ slot: 0 })
  })

  it('refuses when N is held, and claims nothing else (slot 0 free)', () => {
    const c = claims([7])
    const got = chooseSlot(['rysh', '--instance=7'], c.claim)
    expect(got).toEqual({ error: expect.stringContaining('Instance 7 is already running') })
    expect(c.tried).toEqual([7])
  })

  it('refuses an invalid N without claiming anything', () => {
    for (const bad of ['--instance=', '--instance=abc', '--instance=-1', '--instance=32', '--instance=2x', '--instance=1.5']) {
      const c = claims([])
      expect(chooseSlot(['rysh', bad], c.claim), bad).toHaveProperty('error')
      expect(c.tried, bad).toEqual([])
    }
  })
})

describe('chooseSlot --new-instance', () => {
  it('takes the lowest free slot >= 1, never 0', () => {
    expect(chooseSlot(['rysh', '--new-instance'], claims([]).claim)).toEqual({ slot: 1 })
    expect(chooseSlot(['rysh', '--new-instance'], claims([0, 1, 2]).claim)).toEqual({ slot: 3 })
  })

  it('refuses when every secondary slot is held, instead of running as slot 0', () => {
    const c = claims(ALL.slice(1))
    expect(chooseSlot(['rysh', '--new-instance'], c.claim)).toHaveProperty('error')
    expect(c.tried).not.toContain(0)
  })
})

describe('chooseSlot plain launch', () => {
  it('takes slot 0 when no primary runs, else the lowest free', () => {
    expect(chooseSlot(['rysh'], claims([]).claim)).toEqual({ slot: 0 })
    expect(chooseSlot(['rysh'], claims([0, 1]).claim)).toEqual({ slot: 2 })
  })

  it('refuses when every slot is held, instead of running as slot 0 without its lock', () => {
    expect(chooseSlot(['rysh'], claims(ALL).claim)).toHaveProperty('error')
  })
})
