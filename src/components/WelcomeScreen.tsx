import React, { useEffect, useState } from 'react';

interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: string;
  lastSession?: string;
}

/**
 * WelcomeScreen — the empty state shown when no workspace is loaded (fresh
 * instance, after Close Workspace, or after Detach). No daemon is running in
 * this state; opening a workspace (button or a recent entry) starts one.
 */
export function WelcomeScreen() {
  const [recent, setRecent] = useState<RecentWorkspace[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI?.workspace
      .getRecent()
      .then((list) => setRecent(list || []))
      .catch(() => setRecent([]));
  }, []);

  async function openDialog() {
    setError(null);
    await window.electronAPI?.workspace.open();
  }

  async function openRecent(path: string) {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      const res = await window.electronAPI?.workspace.select(path);
      if (res && !res.success && res.error) setError(res.error);
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-[#1e1e1e] text-[#d4d4d4]">
      {/* Drag strip for the hidden-inset title bar (macOS traffic lights). */}
      <div className="h-9 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
      <div className="flex-1 flex items-center justify-center">
        <div className="w-[440px] max-w-[90vw] select-none">
          <div className="text-3xl font-semibold tracking-tight mb-1">rysh</div>
          <div className="text-[#8a8a8a] text-[13px] mb-8">
            No workspace loaded. Open a project directory containing a{' '}
            <span className="font-mono text-[12px] text-[#aaa]">rysh.config.yaml</span> to start.
          </div>

          <button
            onClick={() => void openDialog()}
            className="w-full mb-6 px-4 py-2.5 rounded bg-[#0e639c] hover:bg-[#1177bb] text-white text-[13px] font-medium cursor-pointer"
          >
            Open Workspace…
          </button>

          {recent.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-[#666] mb-2">
                Recent workspaces
              </div>
              <div className="flex flex-col gap-1 max-h-[40vh] overflow-y-auto">
                {recent.map((w) => (
                  <button
                    key={w.path}
                    onClick={() => void openRecent(w.path)}
                    disabled={opening}
                    title={w.path}
                    className="text-left px-3 py-2 rounded hover:bg-[#2a2a2a] cursor-pointer disabled:opacity-50"
                  >
                    <div className="text-[13px] text-[#d4d4d4]">
                      {w.name}
                      {w.lastSession ? (
                        <span className="text-[#666] text-[11px]"> · {w.lastSession}</span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-[#666] font-mono truncate">{w.path}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <div className="mt-4 text-[12px] text-[#ff8787]">{error}</div>}

          <div className="mt-8 text-[11px] text-[#555]">
            Tip: launching the app again opens another independent instance.
          </div>
        </div>
      </div>
    </div>
  );
}
