import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { pickMobileUI } from './pickMobileUI';

// pickMobileUI reads five ambient signals. jsdom provides location/screen/inner*
// but not matchMedia, and navigator.userAgent is read-only, so each test
// declares the whole environment explicitly — no test inherits another's.

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface Env {
  /** URL path + query, e.g. '/mobile?ui=desktop'. */
  url?: string;
  electron?: boolean;
  coarsePointer?: boolean;
  userAgent?: string;
  screen?: { width: number; height: number };
  inner?: { width: number; height: number };
}

function setEnv(env: Env) {
  window.history.replaceState({}, '', env.url ?? '/');

  if (env.electron) {
    // Only the `typeof !== 'undefined'` check matters; the shape is irrelevant.
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
  } else {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  }

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' ? !!env.coarsePointer : false,
    media: query,
  }));

  Object.defineProperty(window.navigator, 'userAgent', {
    value: env.userAgent ?? MAC_UA,
    configurable: true,
  });

  const screen = env.screen ?? { width: 1920, height: 1080 };
  Object.defineProperty(window, 'screen', {
    value: { width: screen.width, height: screen.height },
    configurable: true,
  });

  const inner = env.inner ?? screen;
  Object.defineProperty(window, 'innerWidth', { value: inner.width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: inner.height, configurable: true });
}

/** A phone: coarse pointer, mobile UA, 390x844 — mobile by every signal. */
const PHONE: Env = {
  coarsePointer: true,
  userAgent: IPHONE_UA,
  screen: { width: 390, height: 844 },
};

/** A plain desktop: fine pointer, desktop UA, 1920x1080. */
const DESKTOP: Env = {
  coarsePointer: false,
  userAgent: MAC_UA,
  screen: { width: 1920, height: 1080 },
};

beforeEach(() => {
  setEnv(DESKTOP);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('pickMobileUI — rule 1: Electron wins over everything', () => {
  it('is desktop in Electron even on a phone-sized coarse-pointer screen', () => {
    setEnv({ ...PHONE, electron: true });
    expect(pickMobileUI()).toBe(false);
  });

  it('is desktop in Electron even with ?ui=mobile', () => {
    setEnv({ ...PHONE, electron: true, url: '/?ui=mobile' });
    expect(pickMobileUI()).toBe(false);
  });

  it('is desktop in Electron even at a /mobile path', () => {
    setEnv({ ...PHONE, electron: true, url: '/mobile' });
    expect(pickMobileUI()).toBe(false);
  });
});

describe('pickMobileUI — rule 2: ?ui= override', () => {
  it('?ui=mobile forces mobile on a full-size desktop', () => {
    setEnv({ ...DESKTOP, url: '/?ui=mobile' });
    expect(pickMobileUI()).toBe(true);
  });

  it('?ui=desktop forces desktop on a phone', () => {
    setEnv({ ...PHONE, url: '/?ui=desktop' });
    expect(pickMobileUI()).toBe(false);
  });

  it('?ui=desktop beats a /mobile path', () => {
    setEnv({ ...PHONE, url: '/mobile?ui=desktop' });
    expect(pickMobileUI()).toBe(false);
  });

  it('an unrecognised ?ui= value falls through to the later rules', () => {
    setEnv({ ...PHONE, url: '/?ui=tablet' });
    expect(pickMobileUI()).toBe(true);
    setEnv({ ...DESKTOP, url: '/?ui=tablet' });
    expect(pickMobileUI()).toBe(false);
  });
});

describe('pickMobileUI — rule 3: path ENDS WITH /mobile', () => {
  // Every case here runs on DESKTOP hardware, so a `true` can only come from
  // the path rule and never from autodetect.
  it('matches a bare /mobile', () => {
    setEnv({ ...DESKTOP, url: '/mobile' });
    expect(pickMobileUI()).toBe(true);
  });

  it('matches the trailing-slash form /mobile/', () => {
    setEnv({ ...DESKTOP, url: '/mobile/' });
    expect(pickMobileUI()).toBe(true);
  });

  it('matches behind a prefix-stripping proxy: /ryshweb/<dev>/mobile', () => {
    setEnv({ ...DESKTOP, url: '/ryshweb/macmini-rysh/mobile' });
    expect(pickMobileUI()).toBe(true);
  });

  it('matches the proxied form with a trailing slash', () => {
    setEnv({ ...DESKTOP, url: '/ryshweb/macmini-rysh/mobile/' });
    expect(pickMobileUI()).toBe(true);
  });

  it('does NOT match /mobile mid-path — this is endsWith, not includes', () => {
    setEnv({ ...DESKTOP, url: '/mobile/settings' });
    expect(pickMobileUI()).toBe(false);
  });

  it('does NOT match a path that merely starts with the word', () => {
    setEnv({ ...DESKTOP, url: '/mobiles' });
    expect(pickMobileUI()).toBe(false);
  });

  it('does not confuse a ?ui-free query string for the path', () => {
    setEnv({ ...DESKTOP, url: '/?next=/mobile' });
    expect(pickMobileUI()).toBe(false);
  });
});

describe('pickMobileUI — rule 4: autodetect (touch AND smallest < 700)', () => {
  it('a coarse-pointer phone-sized screen is mobile', () => {
    setEnv({ coarsePointer: true, userAgent: MAC_UA, screen: { width: 390, height: 844 } });
    expect(pickMobileUI()).toBe(true);
  });

  it('a fine-pointer device with a mobile UA and small screen is mobile', () => {
    setEnv({ coarsePointer: false, userAgent: IPHONE_UA, screen: { width: 390, height: 844 } });
    expect(pickMobileUI()).toBe(true);
  });

  it('an iPad reporting 768 stays desktop', () => {
    // The whole reason the threshold is 700 and not, say, 800.
    setEnv({ coarsePointer: true, userAgent: MAC_UA, screen: { width: 768, height: 1024 } });
    expect(pickMobileUI()).toBe(false);
  });

  it('a coarse-pointer touch laptop stays desktop', () => {
    setEnv({ coarsePointer: true, userAgent: MAC_UA, screen: { width: 1920, height: 1080 } });
    expect(pickMobileUI()).toBe(false);
  });

  it('a narrow desktop window with a fine pointer and desktop UA stays desktop', () => {
    // Small viewport, but no touch signal at all — resizing a browser window
    // must not swap the user into the phone UI.
    setEnv({
      coarsePointer: false,
      userAgent: MAC_UA,
      screen: { width: 1920, height: 1080 },
      inner: { width: 420, height: 900 },
    });
    expect(pickMobileUI()).toBe(false);
  });

  it('a touch device with a narrow *window* on a big screen is mobile', () => {
    // smallest considers innerWidth too, not just screen.
    setEnv({
      coarsePointer: true,
      userAgent: MAC_UA,
      screen: { width: 1920, height: 1080 },
      inner: { width: 420, height: 900 },
    });
    expect(pickMobileUI()).toBe(true);
  });

  it('699 is mobile and 700 is not — the boundary is exclusive', () => {
    setEnv({ coarsePointer: true, userAgent: MAC_UA, screen: { width: 699, height: 1400 } });
    expect(pickMobileUI()).toBe(true);
    setEnv({ coarsePointer: true, userAgent: MAC_UA, screen: { width: 700, height: 1400 } });
    expect(pickMobileUI()).toBe(false);
  });

  it('survives a browser with no matchMedia at all', () => {
    setEnv({ coarsePointer: false, userAgent: IPHONE_UA, screen: { width: 390, height: 844 } });
    vi.stubGlobal('matchMedia', undefined);
    expect(pickMobileUI()).toBe(true); // UA still carries it
  });
});
