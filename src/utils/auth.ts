// Browser-mode login for the rysh web server.
//
// The server (rysh-cli internal/web) takes one credential: the username/
// password login set by `##rysh web auth username=<u> password=<p>` (or
// `##rysh web start --username <u> --password <p>`), which returns a JWT valid
// for 30 days. We keep that JWT in localStorage and present it as
// `Authorization: Bearer …` on API calls and as ?token= on the WebSocket
// upgrade (a browser cannot set headers on a WebSocket handshake).
//
// There is no refresh token by design. When the JWT expires the server stops
// authenticating it, /api/auth/status reports authenticated:false, and the
// AuthGate shows the login form again.
//
// None of this runs in Electron: the desktop app's sidecar runs in control
// mode — loopback-only, no login — so there is nothing to present.

const STORAGE_KEY = 'rysh.web.token';

/**
 * Base URL prefix for same-origin API calls. The bundle may be served behind a
 * prefix-stripping reverse proxy (dev.rysh.ai/ryshweb/<dev>/ → /), where an
 * absolute "/api/…" would escape the proxied subtree — so derive the prefix
 * from the page path by dropping the "mobile" segment.
 */
export function apiBase(): string {
  let base = window.location.pathname.replace(/mobile\/?$/, '');
  if (!base.endsWith('/')) base += '/';
  return base;
}

/** The stored access token, or '' when nobody is signed in. */
export function getToken(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    // Private-mode / disabled storage: treat as signed out rather than
    // breaking the whole app on a getItem throw.
    return '';
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* storage unavailable — the session simply won't survive a reload */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * fetch against the rysh web server: proxy-safe base, and the bearer token
 * attached when we have one. Accepts absolute-looking paths ("/api/env") and
 * rewrites them onto apiBase().
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = apiBase() + path.replace(/^\//, '');
  const token = getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

/** Suffix appended to the /ws query string so the upgrade carries the token. */
export function wsAuthQuery(): string {
  const token = getToken();
  return token ? `&token=${encodeURIComponent(token)}` : '';
}

export interface AuthStatus {
  /** The server has a username/password login configured. */
  loginRequired: boolean;
  /** This browser is authorized (by JWT, or by the access-token cookie). */
  authenticated: boolean;
  username: string;
}

/**
 * Ask the server which of the three states we are in. A server too old to know
 * the endpoint, or one that is simply unreachable, is reported as "no login
 * required" — the app then behaves exactly as it did before login existed.
 */
export async function fetchAuthStatus(): Promise<AuthStatus> {
  try {
    const resp = await apiFetch('/api/auth/status');
    if (!resp.ok) return { loginRequired: false, authenticated: true, username: '' };
    const raw = await resp.json();
    return {
      loginRequired: raw?.login_required === true,
      authenticated: raw?.authenticated === true,
      username: String(raw?.username || ''),
    };
  } catch {
    return { loginRequired: false, authenticated: true, username: '' };
  }
}

/**
 * Exchange a username and password for an access token, storing it on success.
 * Throws an Error whose message is safe to show in the form.
 */
export async function login(username: string, password: string): Promise<string> {
  const resp = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  let body: any = null;
  try {
    body = await resp.json();
  } catch {
    /* fall through to the status-based message */
  }
  if (!resp.ok || !body?.token) {
    throw new Error(body?.error || 'sign-in failed');
  }
  setToken(String(body.token));
  return String(body.username || username);
}
