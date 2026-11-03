import { beforeEach, expect, it, vi } from 'vitest';
import { apiFetch, clearToken, getToken, setToken, wsProtocols } from './auth';

const cli = '/ryshweb/macminirysh/';
const desktop = '/ryshweb/macminiryshelect/';
const navigate = (path: string) => window.history.replaceState({}, '', path);

beforeEach(() => {
  vi.unstubAllGlobals();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  navigate(cli);
});

it('keeps two same-origin sessions signed in independently, including logout', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  setToken('cli-token');
  navigate(desktop);
  expect(getToken()).toBe('');
  setToken('desktop-token');
  for (const [path, token] of [[cli, 'cli-token'], [desktop, 'desktop-token'], [cli, 'cli-token']]) {
    navigate(path);
    expect(getToken()).toBe(token);
    expect(wsProtocols()).toEqual(['rysh-auth', `rysh-auth.${token}`]);
    await apiFetch('/api/auth/status');
    const calls = fetchMock.mock.calls;
    const [url, init] = calls[calls.length - 1]!;
    expect(url).toBe(`${path}api/auth/status`);
    expect(init.headers.get('X-Rysh-Token')).toBe(token);
    expect(init.headers.has('Authorization')).toBe(false);
  }
  clearToken();
  expect(getToken()).toBe('');
  navigate(desktop);
  expect(getToken()).toBe('desktop-token');
});

it('shares the session token between desktop and mobile routes', () => {
  setToken('cli-token');
  navigate(`${cli}mobile/`);
  expect(getToken()).toBe('cli-token');
  navigate(`${cli}mobile`);
  expect(getToken()).toBe('cli-token');
  clearToken();
  navigate(cli);
  expect(getToken()).toBe('');
});

it('does not read or erase the ambiguous legacy token', () => {
  localStorage.setItem('rysh.web.token', 'legacy-token');
  expect(getToken()).toBe('');
  setToken('new-token');
  clearToken();
  expect(localStorage.getItem('rysh.web.token')).toBe('legacy-token');
});

// /ryshweb is fronted by nginx Basic auth, which needs the Authorization header
// for itself (security-lead ledger 86): the login JWT rides X-Rysh-Token on API
// calls and a WebSocket subprotocol on /ws, and never the URL.
it('sends the login JWT as X-Rysh-Token and leaves Authorization to the browser', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  setToken('jwt.payload.sig');
  await apiFetch('/api/env', { headers: { 'Content-Type': 'application/json' } });
  const [, init] = fetchMock.mock.calls[0]!;
  expect(init.headers.get('X-Rysh-Token')).toBe('jwt.payload.sig');
  expect(init.headers.has('Authorization')).toBe(false);
  expect(init.headers.get('Content-Type')).toBe('application/json');
});

it('keeps an Authorization header the caller set itself', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  setToken('jwt.payload.sig');
  await apiFetch('/api/env', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } });
  const [, init] = fetchMock.mock.calls[0]!;
  expect(init.headers.get('Authorization')).toBe('Basic dXNlcjpwYXNz');
  expect(init.headers.get('X-Rysh-Token')).toBe('jwt.payload.sig');
});

it('sends no credential header and offers no subprotocol when signed out', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  await apiFetch('/api/auth/status');
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe(`${cli}api/auth/status`);
  expect(init.headers.has('X-Rysh-Token')).toBe(false);
  expect(init.headers.has('Authorization')).toBe(false);
  expect(wsProtocols()).toEqual([]);
});

// security-lead N1 (ledger 87): a corrupted stored value must not reach the
// WebSocket constructor, which throws SyntaxError on a non-token subprotocol.
it('offers no subprotocol for a stored value that is not a JWT-shaped token', () => {
  for (const bad of ['two words', 'a,b', 'line\nbreak', 'quo"te', 'semi;colon', 'ünï']) {
    setToken(bad);
    expect(wsProtocols()).toEqual([]);
  }
  setToken('aB0-_.zZ9');
  expect(wsProtocols()).toEqual(['rysh-auth', 'rysh-auth.aB0-_.zZ9']);
});
