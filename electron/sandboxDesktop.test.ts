// @vitest-environment node
//
// rr-order-154 C8 (boat-web): the desktop-app half of the sandbox desktop viewer. The app
// never talks to rysh-server itself (design 037) and holds no new credential: it opens the
// rysh.ai viewer page (/workspaces/:wsID/sandboxes/:sandboxID/desktop) in a locked-down
// window where the person signs in to rysh.ai as on the web. Dark: off unless
// RYSH_EXPERIMENTAL_SANDBOXES=1. Driven here with a fake BrowserWindow: no app launch.
import { describe, expect, it, vi } from 'vitest';
import { guardWebContents, openSandboxDesktop, sandboxDesktopLinksInArgv, sandboxesEnabled, viewerUrl, windowOptions } from './sandboxDesktop';
import { connectLinksInArgv } from './companyConnect';

type Handler = (...a: any[]) => any;
function fakeWebContents() {
  const on: Record<string, Handler> = {};
  const wc = {
    openHandler: null as Handler | null,
    permReq: null as Handler | null,
    permCheck: null as Handler | null,
    setWindowOpenHandler(h: Handler) { wc.openHandler = h; },
    on(ev: string, h: Handler) { on[ev] = h; },
    emit(ev: string, ...a: any[]) { return on[ev]?.(...a); },
    session: {
      setPermissionRequestHandler(h: Handler) { wc.permReq = h; },
      setPermissionCheckHandler(h: Handler) { wc.permCheck = h; },
    },
  };
  return wc;
}
class FakeWindow {
  static made: FakeWindow[] = [];
  webContents = fakeWebContents();
  loaded: string[] = [];
  constructor(public opts: any) { FakeWindow.made.push(this); }
  loadURL(u: string) { this.loaded.push(u); return Promise.resolve(); }
}

const link = (server = 'https%3A%2F%2Frysh.ai', mode = 'watch') =>
  `rysh://sandbox-desktop?server=${server}&workspace=w1&sandbox=s1&mode=${mode}`;
const deps = (over: Partial<any> = {}) => ({
  env: { RYSH_EXPERIMENTAL_SANDBOXES: '1' } as Record<string, string | undefined>,
  BrowserWindow: FakeWindow as any,
  openExternal: vi.fn(),
  confirm: vi.fn().mockResolvedValue(null),
  ...over,
});

describe('sandboxesEnabled', () => {
  it('only the exact value "1"', () => {
    expect(sandboxesEnabled({})).toBe(false);
    expect(sandboxesEnabled({ RYSH_EXPERIMENTAL_SANDBOXES: 'true' })).toBe(false);
    expect(sandboxesEnabled({ RYSH_EXPERIMENTAL_SANDBOXES: '1' })).toBe(true);
  });
});

describe('viewerUrl', () => {
  it('is the web viewer route on the server origin, ids encoded, mode in the query', () => {
    expect(viewerUrl({ server: 'https://rysh.ai/some/path', workspaceID: 'w1', sandboxID: 's1', mode: 'control' }))
      .toBe('https://rysh.ai/workspaces/w1/sandboxes/s1/desktop?mode=control');
  });
  it('never takes its origin from the link', () => {
    expect(viewerUrl({ server: 'https://evil.example', workspaceID: 'w1', sandboxID: 's1', mode: 'watch' }))
      .toMatch(/^https:\/\/rysh\.ai\//);
  });
});

describe('windowOptions', () => {
  it('no preload, no Node, sandboxed, isolated, its own persistent partition', () => {
    const o = windowOptions('Sandbox s1');
    expect(o.webPreferences).toMatchObject({
      contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false,
      partition: 'persist:rysh-sandbox-desktop',
    });
    expect(o.webPreferences.preload).toBeUndefined();
    expect(o.title).toBe('Sandbox s1');
  });
});

describe('guardWebContents', () => {
  const origin = 'https://rysh.ai';
  it('denies every popup; an https one opens in the system browser', () => {
    const wc = fakeWebContents();
    const ext = vi.fn();
    guardWebContents(wc as any, origin, ext);
    expect(wc.openHandler!({ url: 'https://accounts.google.com/x' })).toEqual({ action: 'deny' });
    expect(ext).toHaveBeenCalledWith('https://accounts.google.com/x');
    expect(wc.openHandler!({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(ext).toHaveBeenCalledTimes(1);
  });

  it('keeps navigation on the server origin', () => {
    const wc = fakeWebContents();
    const ext = vi.fn();
    guardWebContents(wc as any, origin, ext);
    const same = { preventDefault: vi.fn() };
    wc.emit('will-navigate', same, 'https://rysh.ai/login');
    expect(same.preventDefault).not.toHaveBeenCalled();
    const other = { preventDefault: vi.fn() };
    wc.emit('will-navigate', other, 'https://evil.example/');
    expect(other.preventDefault).toHaveBeenCalled();
    expect(ext).toHaveBeenCalledWith('https://evil.example/');
    const file = { preventDefault: vi.fn() };
    wc.emit('will-navigate', file, 'file:///etc/passwd');
    expect(file.preventDefault).toHaveBeenCalled();
    expect(ext).toHaveBeenCalledTimes(1);
  });

  it('refuses every permission (camera, microphone, notifications, …)', () => {
    const wc = fakeWebContents();
    guardWebContents(wc as any, origin, vi.fn());
    const cb = vi.fn();
    wc.permReq!(null, 'media', cb);
    expect(cb).toHaveBeenCalledWith(false);
    expect(wc.permCheck!(null, 'clipboard-read')).toBe(false);
  });
});

describe('openSandboxDesktop', () => {
  it('off by default: opens nothing', async () => {
    FakeWindow.made = [];
    const r = await openSandboxDesktop(link(), deps({ env: {} }));
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/not enabled/) });
    expect(FakeWindow.made).toHaveLength(0);
  });

  it('rysh.ai: opens the viewer in a guarded window', async () => {
    FakeWindow.made = [];
    const d = deps();
    const r = await openSandboxDesktop(link(), d);
    expect(r).toEqual({ ok: true });
    expect(d.confirm).not.toHaveBeenCalled();
    const w = FakeWindow.made[0];
    expect(w.opts.webPreferences.nodeIntegration).toBe(false);
    expect(w.loaded).toEqual(['https://rysh.ai/workspaces/w1/sandboxes/s1/desktop?mode=watch']);
    expect(w.webContents.openHandler).not.toBeNull();
    expect(w.webContents.permReq).not.toBeNull();
  });

  it('pinned to rysh.ai: a link naming any other server opens nothing and asks nothing (desktop 11-09)', async () => {
    for (const server of ['https%3A%2F%2Fdev.rysh.ai', 'https%3A%2F%2Fletchat.ai', 'https%3A%2F%2Frysh.ai.evil.example', 'https%3A%2F%2Frysh.ai%3A8443']) {
      FakeWindow.made = [];
      const d = deps();
      const r = await openSandboxDesktop(link(server), d);
      expect(r.ok, server).toBe(false);
      expect(d.confirm).not.toHaveBeenCalled();
      expect(FakeWindow.made).toHaveLength(0);
    }
  });

  it('plain http to a remote host and a bad link are refused', async () => {
    FakeWindow.made = [];
    expect((await openSandboxDesktop(link('http%3A%2F%2Fevil.example'), deps())).ok).toBe(false);
    expect((await openSandboxDesktop('rysh://sandbox-desktop?sandbox=..', deps())).ok).toBe(false);
    expect(FakeWindow.made).toHaveLength(0);
  });
});

// Linux passes a cold-start link in argv: a sandbox link must reach the sandbox window,
// never the connect queue (where it would show "not a connect code").
describe('links in argv', () => {
  const argv = ['/app', '--flag', 'rysh://connect?server=https%3A%2F%2Frysh.ai&token=x', 'rysh://sandbox-desktop?server=https%3A%2F%2Frysh.ai&workspace=w1&sandbox=s1', 'RYSH:///Sandbox-Desktop?x=1'];
  it('sandbox links go to the sandbox handler', () => {
    expect(sandboxDesktopLinksInArgv(argv)).toEqual([argv[3], argv[4]]);
  });
  it('the connect queue keeps only the other rysh:// links', () => {
    expect(connectLinksInArgv(argv)).toEqual([argv[2]]);
  });
});

