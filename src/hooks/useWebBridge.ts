import { useEffect } from 'react';
import { useStore } from '../store';
import { apiFetch } from '../utils/auth';
import type { WebEnv } from '../types';

/**
 * useWebBridge — the browser-mode counterpart of useElectronBridge
 * (web_electron_roadmap W9). When the page runs WITHOUT window.electronAPI it
 * fetches GET /api/env from its own origin (the rysh web server, same-origin
 * and token-cookie gated) and publishes the result as store.webEnv:
 *
 *   - a real "is web" signal (instead of feature-sniffing electronAPI),
 *   - platform / session name (Electron's getPlatform / getSessionName),
 *   - the current workspace (Electron's workspace.getCurrent, W8),
 *   - voice config (Electron's voice.getConfig, W10),
 *   - a capability map, so features are visibly present or absent.
 *
 * No-op in Electron — the electronAPI branch stays primary there.
 */
export function useWebBridge() {
  useEffect(() => {
    if (window.electronAPI) return; // Electron: useElectronBridge owns init

    let cancelled = false;
    (async () => {
      try {
        const resp = await apiFetch('/api/env');
        if (!resp.ok) return; // older server without /api/env — degrade as before
        const raw = await resp.json();
        if (cancelled || !raw || raw.is_web !== true) return;

        const caps = raw.capabilities || {};
        const env: WebEnv = {
          isWeb: true,
          platform: String(raw.platform || ''),
          sessionName: String(raw.session_name || ''),
          control: !!raw.control,
          workspace: {
            path: String(raw.workspace?.path || ''),
            name: String(raw.workspace?.name || ''),
          },
          capabilities: {
            completion: !!caps.completion,
            workspaces: !!caps.workspaces,
            voice: !!caps.voice,
            webPane: !!caps.web_pane,
            restartDaemon: !!caps.restart_daemon,
            nativeOpen: !!caps.native_open,
          },
        };
        const store = useStore.getState();
        store.setWebEnv(env);

        // W8: populate the workspace identity the desktop app gets from
        // workspace.getCurrent(). (The ws: switcher row itself renders from
        // the snapshot, which web mode already receives.)
        if (env.workspace.path) {
          store.setWorkspace(env.workspace.path, env.workspace.name);
        }

        // W10: voice config — same store slice the Electron bridge fills, so
        // PaneInput's mic button and the ctrl+r hotkey light up identically.
        if (raw.voice) {
          store.setVoiceConfig({
            enabled: raw.voice.enabled === true,
            provider: String(raw.voice.provider || 'deepgram'),
            hotkey: String(raw.voice.hotkey || 'ctrl+r'),
            language: String(raw.voice.language || ''),
          });
        }
      } catch {
        // Server unreachable or pre-parity: leave webEnv null — the UI keeps
        // the conservative (capability-less) web defaults.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
