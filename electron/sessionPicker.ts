import { dialog, BrowserWindow } from 'electron'
import { listOpenableSessions, type AppSession } from './sessionStore'
import { DaemonRegistry, isPidAlive } from './daemonRegistry'

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
 * Show a native dialog listing every session in this workspace and let the user
 * pick one, create a new one, or cancel. When the workspace has no sessions
 * yet, returns { kind: 'new' } so the caller goes straight to naming one.
 *
 * Command-line sessions used to be filtered out, because the two front-ends
 * refused to open each other's. They no longer do — the app is a superset of
 * the terminal's render surfaces, so it opens a terminal session with nothing
 * lost. Origin is shown as a label instead of a filter.
 */
export async function pickSession(
  parent: BrowserWindow,
  workspaceRoot: string
): Promise<SessionChoice> {
  const sessions = listOpenableSessions(workspaceRoot)
  if (sessions.length === 0) {
    return { kind: 'new' }
  }

  // A session with a live daemon is adoptable: opening it reconnects with full
  // in-memory state, where a cold session restores layout + content from KV
  // only. Two ways to be live — a daemon this app left running (the registry)
  // or any other daemon still holding its recorded PID, which is how a
  // command-line session shows up here.
  const registry = new DaemonRegistry()
  const isLive = (s: AppSession): boolean =>
    !!registry.findAlive(workspaceRoot, s.name) || (s.pid > 0 && isPidAlive(s.pid))

  // Button layout: [session…, "New Session…", "Cancel"]. response is the index
  // into this array regardless of how the OS visually arranges the buttons.
  const sessionLabels = sessions.map((s) => sessionLabel(s, isLive(s)))
  const buttons = [...sessionLabels, 'New Session…', 'Cancel']

  const anyLive = sessions.some((s) => isLive(s))

  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    title: 'Open Rysh Session',
    message: 'Select a session to open',
    detail: anyLive
      ? '● = running — reattaches with full state.\n"terminal" marks a session created from the command line.'
      : '"terminal" marks a session created from the command line.',
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
 * Human label for a session button, e.g. "work  —  detached (terminal)".
 *
 * A live (adoptable) daemon is marked with a ● and labelled "running" so the
 * user knows it reattaches with full in-memory state; one that another app
 * window is currently connected to shows "attached (app)" instead, so the user
 * knows opening it here joins a session that is already on screen.
 *
 * Sessions created from the command line are marked "(terminal)" — not as a
 * warning (the app renders everything a terminal can, and more) but because
 * opening one may join a session someone is driving from a shell right now.
 */
function sessionLabel(s: AppSession, live: boolean): string {
  const origin = s.source === 'cli' ? ' (terminal)' : ''
  if (live && s.appClients > 0) return `● ${s.name}  —  attached (app)${origin}`
  if (live) return `● ${s.name}  —  running${origin}`
  return `${s.name}  —  ${s.state}${origin}`
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
