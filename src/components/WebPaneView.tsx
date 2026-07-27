import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useStore, findPane } from '../store';
import { BrowserAgentChat } from './BrowserAgentChat';

interface Props {
  paneId: string;
}

/**
 * WebPaneView renders the web pane UI: a toolbar with back/forward/reload buttons
 * and a URL bar. The actual web content is rendered by a BrowserView/WebContentsView
 * in the Electron main process, overlaid on top of this component's DOM element.
 *
 * In browser mode (no Electron), shows a message that web panes require the desktop app.
 */
export const WebPaneView = React.memo(function WebPaneView({ paneId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const status = useStore((s) => s.webPaneStatuses[paneId]);
  // The backend web binding (set by `##mode new web`): drives creation/navigation
  // of the embedded WebContentsView. The `web_activate` push delivers it
  // deterministically (store.webBindings); the snapshot's web_profile/web_url is
  // the fallback for restore-on-startup (no push happened this session) and can
  // lag/arrive stale, so the push is preferred. Selecting scalars keeps re-renders
  // minimal.
  const binding = useStore((s) => s.webBindings[paneId]);
  const snapUrl = useStore((s) => findPane(s.snapshot, paneId)?.web_url || '');
  const snapProfile = useStore((s) => findPane(s.snapshot, paneId)?.web_profile || '');
  const webUrl = binding?.url || snapUrl;
  const webProfile = binding?.profile || snapProfile;
  // The profile this component last asked the main process to bind. null until
  // the first create. When it differs from webProfile, the backend rebound the
  // pane to a new profile (`##mode new web --profile <other>`) and we must call
  // create() again (which recreates the view against the new partition), not
  // navigate() (which would keep the old profile's cookie jar).
  const createdProfileRef = useRef<string | null>(null);
  // "Ask Rysh" panel visibility, persisted per pane in the store so it survives
  // input-mode cycling (which remounts this view). Undefined → OPEN, so the
  // panel shows on the right the first time a web pane opens; an explicit close
  // is remembered.
  const chatOpen = useStore((s) => s.webChatOpen[paneId] !== false);
  const setWebChatOpen = useStore((s) => s.setWebChatOpen);
  const isElectron = !!window.electronAPI;

  // Editable URL-bar text. The bar must NOT be a controlled input bound directly
  // to status.url (with a no-op onChange) — that reverts every keystroke and made
  // the bar untypeable. Keep local state, and re-sync from the authoritative
  // status.url only while the bar is not focused (so navigation updates show, but
  // in-progress typing is never clobbered).
  const [urlText, setUrlText] = useState('');
  const urlFocusedRef = useRef(false);
  useEffect(() => {
    if (!urlFocusedRef.current) setUrlText(status?.url || '');
  }, [status?.url]);

  // Track the page area's rect and keep the native WebContentsView pinned to it,
  // so the browser strictly fits the pane and never overflows.
  useEffect(() => {
    if (!isElectron || !containerRef.current) return;
    const el = containerRef.current;

    const updateBounds = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      window.electronAPI!.webPane.setBounds(paneId, {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        // floor width/height so the view never rounds UP past the pane edge.
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
      });
    };

    // ResizeObserver catches size changes; window resize + ancestor scroll catch
    // position-only moves (which ResizeObserver misses), e.g. the window resizing
    // or layout shifting the pane without changing the page area's own size.
    const observer = new ResizeObserver(updateBounds);
    observer.observe(el);
    window.addEventListener('resize', updateBounds);
    window.addEventListener('scroll', updateBounds, true);
    updateBounds();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('scroll', updateBounds, true);
      // Detach (not destroy) on unmount: a fullscreen toggle / stack rotation
      // unmounts then immediately remounts this component, and destroying the
      // WebContentsView would lose the live page (reloading the bound URL, or
      // about:blank). detach() hides the view (setVisible false) and defers
      // teardown so a quick remount re-attaches the same live page; a genuine
      // close still tears down.
      window.electronAPI?.webPane.detach(paneId);
      // Force the next mount through create() (its reattach branch re-shows the
      // hidden view via setVisible(true)) instead of navigate() (which neither
      // re-shows nor avoids a duplicate loadURL). Without this reset the ref
      // survives a same-instance remount — React StrictMode in dev, where the
      // mount→unmount→remount cycle would otherwise leave the view detached
      // (setVisible false) AND fire a second loadURL that ERR_ABORTEDs the
      // first, so the page loads but never paints. create() is idempotent: its
      // entry/profile check reattaches the live page without reloading.
      createdProfileRef.current = null;
    };
  }, [paneId, isElectron]);

  // Create the WebContentsView once the backend reports a web binding (profile),
  // recreate it if the bound profile changes, and navigate on plain URL changes.
  // The persistent Chromium profile is bound by name (rysh-cli
  // `##mode new web --profile`). createdProfileRef resets on unmount; on a quick
  // remount the manager reattaches the same live view when the profile matches.
  useEffect(() => {
    if (!isElectron || !webProfile) return;
    const url = webUrl || 'about:blank';
    if (createdProfileRef.current !== webProfile) {
      // First create, or the bound profile changed: (re)create against this
      // profile's partition. The manager reattaches the live view when the
      // profile is unchanged and destroys+recreates when it differs.
      createdProfileRef.current = webProfile;
      window.electronAPI!.webPane.create(paneId, url, webProfile);
    } else {
      window.electronAPI!.webPane.navigate(paneId, url);
    }
  }, [isElectron, paneId, webUrl, webProfile]);

  const handleNavigate = useCallback((url: string) => {
    if (!isElectron) return;
    window.electronAPI!.webPane.navigate(paneId, url);
  }, [paneId, isElectron]);

  const handleBack = useCallback(() => {
    if (!isElectron) return;
    window.electronAPI!.webPane.goBack(paneId);
  }, [paneId, isElectron]);

  const handleForward = useCallback(() => {
    if (!isElectron) return;
    window.electronAPI!.webPane.goForward(paneId);
  }, [paneId, isElectron]);

  const handleReload = useCallback(() => {
    if (!isElectron) return;
    window.electronAPI!.webPane.reload(paneId);
  }, [paneId, isElectron]);

  if (!isElectron) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666] p-5 text-center">
        <div>
          <div className="text-lg mb-2">Web panes require the Rysh desktop app</div>
          <div className="text-sm text-[#555]">
            Use <code className="bg-[#333] px-1 rounded">##web &lt;url&gt;</code> in the desktop app to embed websites in panes.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="web-pane-container">
      {/* Navigation toolbar */}
      <div className="web-pane-toolbar">
        <button
          onClick={handleBack}
          disabled={!status?.canGoBack}
          title="Back"
        >
          &#9664;
        </button>
        <button
          onClick={handleForward}
          disabled={!status?.canGoForward}
          title="Forward"
        >
          &#9654;
        </button>
        <button
          onClick={handleReload}
          title="Reload"
        >
          &#8635;
        </button>
        {status?.loading && (
          <span className="text-[#00d7d7] text-[10px] animate-pulse">loading...</span>
        )}
        <button
          onClick={() => setWebChatOpen(paneId, !chatOpen)}
          title={chatOpen ? 'Hide Ask Rysh' : 'Ask Rysh (AI can browse this page)'}
          className={`whitespace-nowrap ${chatOpen ? 'text-[#87ffff]' : ''}`}
        >
          Ask Rysh
        </button>
        <input
          type="text"
          className="web-pane-url-bar"
          value={urlText}
          placeholder="Enter URL..."
          onChange={(e) => setUrlText(e.target.value)}
          onFocus={() => { urlFocusedRef.current = true; }}
          onBlur={() => { urlFocusedRef.current = false; setUrlText(status?.url || ''); }}
          onKeyDown={(e) => {
            // Stop the global multiplexer keybindings from acting on URL-bar keys.
            e.stopPropagation();
            if (e.key === 'Enter') {
              const url = urlText.trim();
              if (url) {
                // Add protocol if missing (also passes through about:, file:, etc.)
                const fullUrl = /^[a-z]+:\/\//i.test(url) || url.startsWith('about:')
                  ? url
                  : `https://${url}`;
                handleNavigate(fullUrl);
                (e.target as HTMLInputElement).blur();
              }
            }
          }}
        />
      </div>

      {/* Page area + optional Ask-Rysh chat. The native WebContentsView is
          overlaid on containerRef; opening the chat shrinks containerRef (the
          ResizeObserver resizes the native view) so the chat DOM sits beside it,
          not hidden behind the native view. */}
      <div className="flex flex-1 min-h-0">
        <div
          ref={containerRef}
          className="flex-1"
          style={{ minHeight: 100 }}
        />
        {chatOpen && <BrowserAgentChat paneId={paneId} />}
      </div>

      {/* Title bar */}
      {status?.title && (
        <div className="px-2 py-0.5 text-[#808080] text-[11px] border-t border-[#333] bg-[#1a1a1a] truncate">
          {status.title}
        </div>
      )}
    </div>
  );
});
