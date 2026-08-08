import { useEffect } from 'react';
import { useStore } from '../store';

/**
 * Initializes the Electron bridge: fetches sidecar port,
 * registers web pane status listeners, handles workspace changes, etc.
 * No-op when running in a regular browser.
 */
export function useElectronBridge() {
  useEffect(() => {
    if (!window.electronAPI) return;

    // Fetch the sidecar port, which is what triggers the WebSocket connect.
    // The daemon needs no credential from us: the app spawns it in control
    // mode (loopback-only, no login), and a daemon it adopts is reached the
    // same way.
    window.electronAPI.getPort().then((port) => {
      useStore.getState().setSidecarPort(port);
      console.log('[electron] Sidecar port:', port);
    });

    // Fetch voice-prompting config (enabled, provider, hotkey).
    window.electronAPI.voice?.getConfig().then((cfg) => {
      useStore.getState().setVoiceConfig(cfg);
      if (cfg.enabled) console.log('[electron] Voice enabled:', cfg.provider);
    }).catch(() => { /* ignore */ });

    // Fetch the current workspace (if one was active from a previous session)
    window.electronAPI.workspace.getCurrent().then((ws) => {
      if (ws) {
        useStore.getState().setWorkspace(ws.path, ws.name);
        console.log('[electron] Current workspace:', ws.name);
      }
    });

    // Listen for workspace changes from the main process
    window.electronAPI.workspace.onChanged((info) => {
      console.log('[electron] Workspace changed:', info.name, 'port:', info.port);

      // port 0 (+ empty path) is the Detach signal: there is no active session.
      // Disconnect and clear the snapshot so the UI shows the empty state, and
      // drop the port so we don't reconnect to the (now detached) daemon.
      if (!info.port) {
        useStore.getState().setWorkspace('', '');
        useStore.getState().clearSession();
        return;
      }

      // Update workspace in store
      useStore.getState().setWorkspace(info.path, info.name);

      // Update sidecar port (sidecar restarts on workspace change with a new port)
      useStore.getState().setSidecarPort(info.port);

      // Close existing WebSocket so it auto-reconnects to the new port
      const ws = useStore.getState().ws;
      if (ws) {
        ws.close();
      }
    });

    // Listen for web pane status updates from the main process
    window.electronAPI.webPane.onStatusUpdate((status) => {
      useStore.getState().setWebPaneStatus(status);
    });

    return () => {
      window.electronAPI?.workspace.removeChangedListener();
      window.electronAPI?.webPane.removeStatusListener();
    };
  }, []);
}
