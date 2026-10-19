import { beforeEach, expect, it, vi } from 'vitest';
import { apiFetch, clearToken, getToken, setToken, wsAuthQuery } from './auth';

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
    expect(wsAuthQuery()).toBe(`&token=${token}`);
    await apiFetch('/api/auth/status');
    const calls = fetchMock.mock.calls;
    const [url, init] = calls[calls.length - 1]!;
    expect(url).toBe(`${path}api/auth/status`);
    expect(init.headers.get('Authorization')).toBe(`Bearer ${token}`);
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
