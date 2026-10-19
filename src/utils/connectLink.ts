/**
 * Company Connect (design 037): everything the desktop app can be handed and
 * turn into a `ry connect <server> <code>` call.
 *
 * The dashboard's "Connect the desktop app" button opens a deep link,
 *   rysh://connect?server=https%3A%2F%2Fletchat.ai&token=rysh_ct_…
 * but a user may equally paste, into the welcome screen, the terminal line
 * (`ry connect https://letchat.ai rysh_ct_…`), the install line
 * (`curl … | RYSH_CONNECT="https://letchat.ai rysh_ct_…" sh`), or just
 * `https://letchat.ai rysh_ct_…`. All four resolve here; anything else is
 * rejected before a process is spawned.
 */
export interface ConnectTarget {
  server: string;
  token: string;
}

const TOKEN_RE = /rysh_ct_[0-9a-f]{48}/;
const SERVER_RE = /https?:\/\/[^\s"'<>]+/;

export function parseConnectLink(input: string): ConnectTarget | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  if (raw.toLowerCase().startsWith('rysh://')) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    // `rysh://connect?…` parses with host "connect"; `rysh:///connect?…` with
    // pathname "/connect". Accept either.
    const action = (url.host || url.pathname.replace(/^\/+/, '')).toLowerCase();
    if (action !== 'connect') return null;
    return finish(url.searchParams.get('server') || '', url.searchParams.get('token') || '');
  }

  // RYSH_CONNECT="<server> <code>" inside an install line.
  const env = raw.match(/RYSH_CONNECT=["']?\s*(https?:\/\/\S+)\s+(rysh_ct_[0-9a-f]+)/);
  if (env) return finish(env[1], env[2]);

  // `ry connect <server> <code>` or a bare `<server> <code>`.
  const token = raw.match(TOKEN_RE)?.[0] || '';
  const server = raw.match(SERVER_RE)?.[0] || '';
  return finish(server, token);
}

function finish(server: string, token: string): ConnectTarget | null {
  server = server.trim().replace(/["']+$/, '').replace(/\/+$/, '');
  token = token.trim();
  if (!/^https?:\/\/[^\s/]+/.test(server)) return null;
  if (!TOKEN_RE.test(token) || token.length !== 'rysh_ct_'.length + 48) return null;
  return { server, token };
}
