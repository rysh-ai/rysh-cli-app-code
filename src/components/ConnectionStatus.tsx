import { useStore } from '../store';

export function ConnectionStatus() {
  const connected = useStore((s) => s.connected);
  const sidecarPort = useStore((s) => s.sidecarPort);

  if (connected) return null;

  // No sidecar port in Electron means there's no active session (e.g. after
  // Detach) — an intentional empty state, not a dropped connection — so don't
  // show the "reconnecting" badge.
  if (window.electronAPI && !sidecarPort) return null;

  return (
    <div className="fixed top-2 right-3 z-[200] px-2.5 py-1 rounded text-[11px] font-bold bg-[#5f0000] text-[#ff5f5f] border border-[#ff5f5f]">
      disconnected &mdash; reconnecting...
    </div>
  );
}
