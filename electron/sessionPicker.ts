import { dialog, BrowserWindow } from 'electron'
import { listAppSessions, type AppSession } from './sessionStore'
import { DaemonRegistry } from './daemonRegistry'

/**
 * The outcome of the native session picker:
 * - existing: open the named app session
 * - new: create a new session (caller prompts for the name)
 * - cancel: do nothing
 */
export type SessionChoice =
  | { kind: 'existing'; name: string }
  | { kind: 'new' }
  | { kind: 'cancel' }

/**
 * Show a native dialog listing the app's sessions for this workspace and let the
 * user pick one, create a new one, or cancel. Only sessions created by the
 * desktop app are listed (the CLI's own sessions are filtered out). When the
 * workspace has no app sessions yet, returns { kind: 'new' } so the caller goes
 * straight to naming a new session.
 */
export async function pickSession(
  parent: BrowserWindow,
  workspaceRoot: string
): Promise<SessionChoice> {
  const sessions = listAppSessions(workspaceRoot)
  if (sessions.length === 0) {
    return { kind: 'new' }
  }

  // A session whose daemon this app left running (Detach) is adoptable: opening
  // it reconnects with full in-memory state. Flag those so the user can tell
  // them apart from cold sessions (which restore layout + content from KV only).
  const registry = new DaemonRegistry()
  const isLive = (name: string): boolean => !!registry.findAlive(workspaceRoot, name)

  // Button layout: [session…, "New Session…", "Cancel"]. response is the index
  // into this array regardless of how the OS visually arranges the buttons.
  const sessionLabels = sessions.map((s) => sessionLabel(s, isLive(s.name)))
  const buttons = [...sessionLabels, 'New Session…', 'Cancel']

  const anyLive = sessions.some((s) => isLive(s.name))

  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    title: 'Open Rysh Session',
    message: 'Select a session to open',
    detail: anyLive
      ? 'Only Rysh desktop-app sessions are shown.\n● = running — reattaches with full state.'
      : 'Only sessions created by the Rysh desktop app are shown.',
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  })

  if (response < sessions.length) {
    return { kind: 'existing', name: sessions[response].name }
  }
  if (response === sessions.length) {
    return { kind: 'new' }
  }
  return { kind: 'cancel' }
}

/**
 * Human label for a session button, e.g. "work  —  detached".
 * A live (adoptable) daemon is marked with a ● and labelled "running" so the
 * user knows it reattaches with full in-memory state; one that another app
 * window is currently connected to shows "attached (app)" instead, so the
 * user knows opening it here joins a session that is already on screen.
 */
function sessionLabel(s: AppSession, live: boolean): string {
  if (live && s.appClients > 0) return `● ${s.name}  —  attached (app)`
  if (live) return `● ${s.name}  —  running`
  return `${s.name}  —  ${s.state}`
}

/**
 * Prompt the user for a new session name in a small modal window (Electron has
 * no native text-input dialog). Returns the trimmed, sanitized name, or null if
 * the user cancelled or left it empty. The page is static HTML; the result is
 * read back via webContents.executeJavaScript, so no preload/nodeIntegration is
 * needed.
 */
export async function promptForSessionName(
  parent: BrowserWindow,
  defaultName: string
): Promise<string | null> {
  const win = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    width: 440,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'New Rysh Session',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(promptHtml(defaultName)))
  win.show()

  // Race the user's choice (from the page) against the window being closed via
  // the title bar, so cancelling either way resolves cleanly.
  let closed = false
  const closedPromise = new Promise<null>((resolve) => {
    win.once('closed', () => {
      closed = true
      resolve(null)
    })
  })

  const valuePromise = win.webContents
    .executeJavaScript(PROMPT_RESOLVER, true)
    .then((v: unknown) => (typeof v === 'string' ? v : null))
    .catch(() => null)

  const raw = await Promise.race([valuePromise, closedPromise])
  if (!closed && !win.isDestroyed()) win.close()

  return sanitizeSessionName(raw)
}

/**
 * Normalize a user-entered session name to match the Go side's session name
 * handling: trim, replace path separators with '-', and reject empty input.
 */
export function sanitizeSessionName(raw: string | null): string | null {
  if (raw == null) return null
  const name = raw.trim().replace(/[/\\]/g, '-')
  return name === '' ? null : name
}

/** HTML-escape a string for safe interpolation into an attribute/text node. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** In-page script: wire up OK/Cancel/Enter/Escape and resolve with the value. */
const PROMPT_RESOLVER = `new Promise((resolve) => {
  const input = document.getElementById('name');
  const ok = document.getElementById('ok');
  const cancel = document.getElementById('cancel');
  input.focus();
  input.select();
  ok.addEventListener('click', () => resolve(input.value));
  cancel.addEventListener('click', () => resolve(null));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') resolve(input.value);
    if (e.key === 'Escape') resolve(null);
  });
})`

/** Minimal dark-themed prompt page matching the app's look. */
function promptHtml(defaultName: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8" />
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #1e1e1e; color: #e6e6e6;
    display: flex; flex-direction: column;
    padding: 18px 20px; box-sizing: border-box; gap: 12px;
  }
  label { font-size: 13px; color: #b8b8b8; }
  input {
    font-size: 14px; padding: 8px 10px; border-radius: 6px;
    border: 1px solid #3a3a3a; background: #2a2a2a; color: #fff; outline: none;
  }
  input:focus { border-color: #5b8cff; }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: auto; }
  button {
    font-size: 13px; padding: 7px 16px; border-radius: 6px;
    border: 1px solid #3a3a3a; background: #2f2f2f; color: #e6e6e6; cursor: pointer;
  }
  button#ok { background: #3a63c8; border-color: #3a63c8; color: #fff; }
  button:hover { filter: brightness(1.12); }
</style>
</head>
<body>
  <label for="name">New session name</label>
  <input id="name" type="text" value="${escapeHtml(defaultName)}" autocomplete="off" spellcheck="false" />
  <div class="row">
    <button id="cancel" type="button">Cancel</button>
    <button id="ok" type="button">Create</button>
  </div>
</body>
</html>`
}
