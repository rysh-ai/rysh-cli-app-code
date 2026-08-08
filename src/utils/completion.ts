import { useStore } from '../store';
import { sendCommand } from './commands';

/**
 * Unified shell tab-completion client (web_electron_roadmap W7).
 *
 * Electron: window.electronAPI.completion.get (main process reads $PATH, the
 * filesystem and bash completion specs).
 *
 * Web mode: the SAME request rides the existing /ws protocol as a
 * `completion_get` command; the server answers only this client with a
 * `completion_result` (the daemon owns the pane's shell, and the shared Go
 * engine — internal/tui — computes the candidates). useWebSocket routes the
 * reply here via resolveCompletionResult.
 */

export interface CompletionOpts {
  paneId: string;
  shellPid: number;
  token: string;
  isFirstToken: boolean;
  cwd: string; // OSC 7-reported live cwd (may be '')
  line: string; // input line up to the cursor
}

export interface CompletionCandidate {
  value: string;
  isDir: boolean;
}

const WEB_COMPLETION_TIMEOUT_MS = 1500;

// In-flight web-mode requests awaiting their completion_result.
const pending = new Map<
  string,
  { resolve: (c: CompletionCandidate[]) => void; timer: ReturnType<typeof setTimeout> }
>();

let nextRequestId = 1;

/** Route a ws `completion_result` frame to its waiting request (no-op for
 *  unknown/expired ids). Called from useWebSocket's message handler. */
export function resolveCompletionResult(data: {
  request_id?: string;
  candidates?: { value?: string; is_dir?: boolean }[];
}): void {
  const id = data?.request_id || '';
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  const cands = (data.candidates || []).map((c) => ({
    value: String(c?.value ?? ''),
    isDir: c?.is_dir === true,
  }));
  entry.resolve(cands.filter((c) => c.value !== ''));
}

/** True when tab-completion can be served in the current runtime. */
export function completionAvailable(): boolean {
  if (window.electronAPI?.completion) return true;
  const s = useStore.getState();
  // Web mode: needs the live socket; the capability is advertised by /api/env
  // (default true when webEnv is known, false before it loads).
  return !!s.ws && s.ws.readyState === WebSocket.OPEN && s.webEnv?.capabilities.completion === true;
}

/** Fetch candidates for the token under the cursor (Electron or web). */
export async function getCompletions(opts: CompletionOpts): Promise<CompletionCandidate[]> {
  // Electron path stays primary when present.
  const api = window.electronAPI?.completion;
  if (api) {
    try {
      const res = await api.get({
        shellPid: opts.shellPid,
        token: opts.token,
        isFirstToken: opts.isFirstToken,
        cwd: opts.cwd,
        line: opts.line,
      });
      return res?.candidates || [];
    } catch {
      return [];
    }
  }

  if (!completionAvailable()) return [];

  const requestId = `c${nextRequestId++}-${Date.now()}`;
  return new Promise<CompletionCandidate[]>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve([]); // timed out — Tab silently does nothing, like an empty match
    }, WEB_COMPLETION_TIMEOUT_MS);
    pending.set(requestId, { resolve, timer });
    sendCommand('completion_get', {
      request_id: requestId,
      pane_id: opts.paneId,
      shell_pid: opts.shellPid,
      token: opts.token,
      is_first_token: opts.isFirstToken,
      cwd: opts.cwd,
      line: opts.line,
    });
  });
}
