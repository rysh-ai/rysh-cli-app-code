import { describe, expect, it } from 'vitest'
import { loadErrorFor, shouldAutoRetry } from './webPaneLoadError'

const SIGN_IN = 'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fmeet.google.com%2Fxxx'

describe('loadErrorFor', () => {
  it('reports a main-frame failure', () => {
    expect(loadErrorFor(-100, 'ERR_CONNECTION_CLOSED', SIGN_IN, true)).toEqual({
      code: -100,
      description: 'ERR_CONNECTION_CLOSED',
      url: SIGN_IN,
    })
  })

  it('ignores subframes, aborts and non-errors', () => {
    expect(loadErrorFor(-100, 'ERR_CONNECTION_CLOSED', SIGN_IN, false)).toBeNull()
    expect(loadErrorFor(-3, 'ERR_ABORTED', SIGN_IN, true)).toBeNull()
    expect(loadErrorFor(0, '', SIGN_IN, true)).toBeNull()
  })

  it('names an error that came without a description', () => {
    expect(loadErrorFor(-105, '', 'https://nx.example/', true)?.description).toBe('error -105')
  })
})

describe('shouldAutoRetry', () => {
  const closed = { code: -100, description: 'ERR_CONNECTION_CLOSED', url: SIGN_IN }

  it('retries a transient connection failure once', () => {
    expect(shouldAutoRetry(closed, undefined)).toBe(true)
    expect(shouldAutoRetry(closed, SIGN_IN)).toBe(false)
    expect(shouldAutoRetry(closed, 'https://meet.google.com/')).toBe(true)
  })

  it('does not retry other failures or non-web URLs', () => {
    expect(shouldAutoRetry({ code: -105, description: 'ERR_NAME_NOT_RESOLVED', url: SIGN_IN }, undefined)).toBe(false)
    expect(shouldAutoRetry({ code: -200, description: 'ERR_CERT_COMMON_NAME_INVALID', url: SIGN_IN }, undefined)).toBe(false)
    expect(shouldAutoRetry({ ...closed, url: 'about:blank' }, undefined)).toBe(false)
  })
})
