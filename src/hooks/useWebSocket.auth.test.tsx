import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWebSocket } from './useWebSocket';
import { useStore } from '../store';
import { clearToken, setToken } from '../utils/auth';

// /ryshweb is fronted by nginx Basic auth (security-lead ledger 86). The login
// JWT must stay out of the /ws URL, where proxies and access logs record it: a
// browser WebSocket cannot set headers, so it is offered as a subprotocol, and
// the server answers with the plain 'rysh-auth' name only.

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string, public protocols?: string | string[]) { FakeWebSocket.last = this; }
  send() {}
  close() {}
}

describe('useWebSocket login JWT on the /ws upgrade (browser mode)', () => {
  beforeEach(() => {
    FakeWebSocket.last = null;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    useStore.setState({ sidecarPort: null });
  });
  afterEach(() => {
    clearToken();
    vi.unstubAllGlobals();
  });

  it('offers the JWT as a subprotocol and never puts it in the URL', () => {
    setToken('jwt.payload.sig');
    const { unmount } = renderHook(() => useWebSocket());
    const ws = FakeWebSocket.last!;
    expect(ws.url).toMatch(/\/ws\?stream=1$/);
    expect(ws.url).not.toContain('token');
    expect(ws.url).not.toContain('jwt.payload.sig');
    expect(ws.protocols).toEqual(['rysh-auth', 'rysh-auth.jwt.payload.sig']);
    unmount();
  });

  it('offers no subprotocol when signed out', () => {
    const { unmount } = renderHook(() => useWebSocket());
    const ws = FakeWebSocket.last!;
    expect(ws.url).not.toContain('token');
    expect(ws.protocols ?? []).toEqual([]);
    unmount();
  });
});
