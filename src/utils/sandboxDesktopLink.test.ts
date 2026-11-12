// rr-order-154 C8 (boat-web): the desktop app opens a rysh sandbox's desktop from
//   rysh://sandbox-desktop?server=https%3A%2F%2Frysh.ai&workspace=<wsID>&sandbox=<sandboxID>&mode=watch|control
// The link names a place, never a credential: a link carrying a token, ticket or key is refused.
// Ids are plain strings in the v1 spec (rysh-server sandboxes-v1.json at boat-api 6a9c3f80), so
// the app accepts only [A-Za-z0-9_-]{1,128} before an id goes into any URL.
import { describe, expect, it } from 'vitest';
import { parseSandboxDesktopLink } from './sandboxDesktopLink';

const base = 'rysh://sandbox-desktop?server=https%3A%2F%2Frysh.ai&workspace=w1&sandbox=s-1_a';

describe('parseSandboxDesktopLink', () => {
  it('reads server, workspace, sandbox and mode', () => {
    expect(parseSandboxDesktopLink(base + '&mode=control')).toEqual({
      server: 'https://rysh.ai', workspaceID: 'w1', sandboxID: 's-1_a', mode: 'control',
    });
  });

  it('accepts the rysh:/// form too', () => {
    expect(parseSandboxDesktopLink(base.replace('rysh://sandbox-desktop', 'rysh:///sandbox-desktop'))?.sandboxID).toBe('s-1_a');
  });

  it('watches unless the link says control', () => {
    expect(parseSandboxDesktopLink(base)?.mode).toBe('watch');
    expect(parseSandboxDesktopLink(base + '&mode=admin')?.mode).toBe('watch');
  });

  it('refuses ids outside [A-Za-z0-9_-]{1,128}', () => {
    for (const bad of ['', '..%2Fx', 'a%2Fb', 'a b', 'x'.repeat(129), 'a%3Fq']) {
      expect(parseSandboxDesktopLink(`rysh://sandbox-desktop?server=https%3A%2F%2Frysh.ai&workspace=w1&sandbox=${bad}`), bad).toBeNull();
      expect(parseSandboxDesktopLink(`rysh://sandbox-desktop?server=https%3A%2F%2Frysh.ai&workspace=${bad}&sandbox=s1`), bad).toBeNull();
    }
  });

  it('refuses a link that carries a credential', () => {
    for (const k of ['token', 'ticket', 'key', 'api_key', 'access_token']) {
      expect(parseSandboxDesktopLink(`${base}&${k}=x`), k).toBeNull();
    }
  });

  it('ignores other links and anything that is not rysh://', () => {
    expect(parseSandboxDesktopLink('rysh://connect?server=https%3A%2F%2Frysh.ai&token=rysh_ct_' + '0'.repeat(48))).toBeNull();
    expect(parseSandboxDesktopLink('https://rysh.ai/workspaces/w1/sandboxes/s1/desktop')).toBeNull();
    expect(parseSandboxDesktopLink('rysh://sandbox-desktop?workspace=w1&sandbox=s1')).toBeNull();
  });
});
