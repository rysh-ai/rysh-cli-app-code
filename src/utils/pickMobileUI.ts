// UI selection: the same bundle backs the Electron renderer, the desktop web UI
// and the mobile drill-down UI. Which React tree mounts is decided once at
// startup (no client-side routing; location is stable for the life of the page):
//
//   1. Electron (window.electronAPI present)       → desktop App, always.
//   2. ?ui=desktop / ?ui=mobile                    → explicit override.
//   3. path ENDS WITH /mobile[/]                   → mobile UI. endsWith (not
//      startsWith) so the check still matches behind a prefix-stripping reverse
//      proxy (e.g. dev.rysh.ai/ryshweb/<dev>/mobile → backend /mobile).
//   4. otherwise auto-detect: a touch device (coarse pointer or mobile UA) with
//      a phone-sized screen gets the drill-down — so opening the plain session
//      URL from a phone just works, no /mobile suffix needed.
//
// Lives here rather than in main.tsx so it can be imported without mounting the
// app: main.tsx calls createRoot() at module scope, so importing that module in
// a test renders the whole tree.
export function pickMobileUI(): boolean {
  // Electron desktop app: never the phone UI.
  if (typeof window.electronAPI !== 'undefined') return false;

  const ui = new URLSearchParams(window.location.search).get('ui');
  if (ui === 'mobile') return true;
  if (ui === 'desktop') return false;

  if (/\/mobile\/?$/.test(window.location.pathname)) return true;

  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const uaMobile = /Android|iPhone|iPod|Windows Phone|IEMobile|Mobile/i.test(
    navigator.userAgent
  );
  // Phone-sized: the smaller dimension of screen or viewport under ~700px.
  // Tablets (iPad reports 768+) and touch laptops keep the desktop UI.
  const smallest = Math.min(
    window.screen?.width ?? Infinity,
    window.screen?.height ?? Infinity,
    window.innerWidth || Infinity,
    window.innerHeight || Infinity
  );
  return (coarse || uaMobile) && smallest < 700;
}
