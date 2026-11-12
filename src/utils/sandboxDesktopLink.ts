/**
 * rysh Sandboxes (rr-order-154 C8): the link that opens a sandbox's desktop in the app,
 *   rysh://sandbox-desktop?server=<https url>&workspace=<wsID>&sandbox=<sandboxID>&mode=watch|control
 * It names a place, never a credential: a link that carries a token, ticket or key is
 * refused. Ids are plain strings in the v1 spec, so only [A-Za-z0-9_-]{1,128} is accepted
 * before an id goes into any URL.
 */
export type SandboxDesktopMode = 'watch' | 'control';

export interface SandboxDesktopTarget {
  server: string;
  workspaceID: string;
  sandboxID: string;
  mode: SandboxDesktopMode;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** A rysh://sandbox-desktop (or rysh:///sandbox-desktop) link, valid or not: never a connect link. */
export function isSandboxDesktopLinkArg(arg: string): boolean {
  return /^rysh:\/\/\/?sandbox-desktop(?:[?/#]|$)/i.test((arg || '').trim());
}
const CREDENTIAL_PARAM = /^(token|ticket|key|api_key|apikey|access_token|secret|password)$/i;

export function parseSandboxDesktopLink(input: string): SandboxDesktopTarget | null {
  const raw = (input || '').trim();
  if (!raw.toLowerCase().startsWith('rysh://')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const action = (url.host || url.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== 'sandbox-desktop') return null;
  for (const k of url.searchParams.keys()) if (CREDENTIAL_PARAM.test(k)) return null;
  const server = url.searchParams.get('server') || '';
  const workspaceID = url.searchParams.get('workspace') || '';
  const sandboxID = url.searchParams.get('sandbox') || '';
  if (!server || !ID_RE.test(workspaceID) || !ID_RE.test(sandboxID)) return null;
  const mode: SandboxDesktopMode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
  return { server, workspaceID, sandboxID, mode };
}
