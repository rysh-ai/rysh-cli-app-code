// Browser-mode login for the rysh web server.
//
// The server (rysh-cli internal/web) takes one credential: the username/
// password login set by `##rysh web auth username=<u> password=<p>` (or
// `##rysh web start --username <u> --password <p>`), which returns a JWT valid
// for 30 days. We keep that JWT in localStorage and present it as
// `X-Rysh-Token: …` on API calls and as the WebSocket subprotocol
// `rysh-auth.<jwt>` on the /ws upgrade (a browser cannot set headers on a
// WebSocket handshake). It never goes in a URL, and Authorization is left
// alone: /ryshweb sits behind nginx Basic auth, which needs that header for
// itself (security-lead ledger 86).
//
// There is no refresh token by design. When the JWT expires the server stops
// authenticating it, /api/auth/status reports authenticated:false, and the
// AuthGate shows the login form again.
//
// None of this runs in Electron: the desktop app's sidecar runs in control
// mode — loopback-only, no login — so there is nothing to present.

// localStorage is shared across an origin, including different proxied
// sessions. Scope tokens to the API base so login/logout in one session
// cannot overwrite or clear another's credentials. Do not migrate the old
// unscoped token: we cannot tell which session issued it.
function storageKey(): string {
  return `rysh.web.token:${apiBase()}`;
}

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
    return window.localStorage.getItem(storageKey()) || '';
  } catch {
    // Private-mode / disabled storage: treat as signed out rather than
    // breaking the whole app on a getItem throw.
    return '';
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(storageKey(), token);
  } catch {
    /* storage unavailable — the session simply won't survive a reload */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(storageKey());
  } catch {
    /* nothing to do */
  }
}

/** The header that carries the login JWT on API calls. */
export const TOKEN_HEADER = 'X-Rysh-Token';
/** The /ws subprotocol the server selects; the JWT rides TOKEN_SUBPROTOCOL + '.' + jwt. */
export const TOKEN_SUBPROTOCOL = 'rysh-auth';

/**
 * fetch against the rysh web server: proxy-safe base, and the login token
 * attached when we have one. Accepts absolute-looking paths ("/api/env") and
 * rewrites them onto apiBase().
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = apiBase() + path.replace(/^\//, '');
  const token = getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set(TOKEN_HEADER, token);
  return fetch(url, { ...init, headers });
}

/**
 * Subprotocols to offer on the /ws upgrade so it carries the token: the plain
 * name (the only one the server echoes) and the name with the JWT appended.
 * Empty when nobody is signed in, and for a stored value that is not
 * JWT-shaped: the WebSocket constructor throws on a non-token subprotocol, so
 * a corrupted value is treated as signed out (the server then asks for a login).
 */
export function wsProtocols(): string[] {
  const token = getToken();
  return /^[A-Za-z0-9._-]+$/.test(token) ? [TOKEN_SUBPROTOCOL, `${TOKEN_SUBPROTOCOL}.${token}`] : [];
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
