// First load of a web pane with the plain-Chrome identity already in place.
//
// The identity override (webPaneManager.applyIdentityOverride) is a set of CDP
// calls: Emulation.setUserAgentOverride, Page.enable and
// Page.addScriptToEvaluateOnNewDocument. The script has to be registered
// BEFORE the first real document, or that document's own scripts read the
// Electron identity (navigator.userAgentData), which is what Google's sign-in
// gate checks.
//
// On Electron 41 those calls never settle on a WebContentsView that has not
// navigated yet: there is no renderer for the debugger to talk to. create()
// used to await them and only then loadURL, so every new web pane (web mode and
// meeting panes alike) stayed blank forever (E30 PM-4a). Measured on 41.10.1:
//
//   await CDP, then load           → CDP never settles; load never happens
//   fire CDP, load at once         → CDP settles, but the first document misses the script
//   load about:blank, CDP, then load → CDP settles in ms; the first real document
//                                      sees the override
//
// So: prime with about:blank, apply the override, then load the URL, with one
// time budget over the first two steps. Whatever the debugger does, loadURL is
// reached within IDENTITY_BUDGET_MS.

export const IDENTITY_BUDGET_MS = 3000

/** The slice of WebContents this needs; a fake in tests. */
export interface BootstrapContents {
  getURL(): string
  loadURL(url: string): Promise<void>
  on(event: 'did-navigate', listener: (event: unknown, url: string) => void): unknown
  removeListener(event: 'did-navigate', listener: (event: unknown, url: string) => void): unknown
  navigationHistory: { clear(): void }
  isDestroyed(): boolean
}

/** Resolves when `p` settles or after `ms`, whichever is first; never rejects. */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<'settled' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  return Promise.race([
    p.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    timeout,
  ]).finally(() => clearTimeout(timer))
}

/**
 * Primes `contents` with about:blank, applies `applyOverride` to it, then loads
 * `url`. The priming page is dropped from history once the real page commits,
 * so Back never lands on about:blank. Resolves once loadURL has been CALLED,
 * with whether the override finished in time and the load itself.
 */
export async function loadWithIdentity(
  contents: BootstrapContents,
  url: string,
  applyOverride: (contents: BootstrapContents) => Promise<void>,
  budgetMs = IDENTITY_BUDGET_MS,
): Promise<{ identity: 'settled' | 'timeout'; load: Promise<void> }> {
  const primed = contents.getURL() === ''
  const verdict = await settleWithin(
    (async () => {
      if (primed) await contents.loadURL('about:blank').catch(() => {})
      await applyOverride(contents)
    })(),
    budgetMs,
  )
  if (primed && !contents.isDestroyed()) {
    const dropPrimer = (_e: unknown, committed: string) => {
      if (committed === 'about:blank') return
      contents.removeListener('did-navigate', dropPrimer)
      try {
        contents.navigationHistory.clear()
      } catch {
        /* view gone */
      }
    }
    contents.on('did-navigate', dropPrimer)
  }
  // The pane may have been closed while the override was being applied.
  if (contents.isDestroyed()) return { identity: verdict, load: Promise.resolve() }
  return { identity: verdict, load: contents.loadURL(url) }
}
