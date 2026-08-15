import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useStore, findPane } from '../store';
import { sendCommand } from '../utils/commands';
import { BrowserAgentChat } from './BrowserAgentChat';
import {
  MOVE_THROTTLE_MS,
  buttonName,
  isForwardableKey,
  isMuxChord,
  modifiersOf,
  pointerAt,
} from '../utils/webPaneInput';

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
    // Browser mode (roadmap W12): a plain tab cannot embed third-party pages
    // (X-Frame-Options / CSP), so the rysh server drives a headless browser
    // and streams frames — or, when that capability is missing, this pane
    // shows an explicit note instead of silently breaking.
    return <ServerWebPaneView paneId={paneId} webUrl={webUrl} webProfile={webProfile} />;
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

/**
 * ServerWebPaneView — browser-mode web pane (web_electron_roadmap W12).
 *
 * The rysh web server drives a headless server-side Chromium for this pane
 * (ws commands webpane_open/navigate/back/forward/reload) and streams JPEG
 * frames + url/title back as `webpane_frame`. When the server lacks the
 * capability (no Chromium / no workspace — /api/env capabilities.web_pane
 * false) or reports an error, that state is shown explicitly: the capability
 * degrades visibly, never silently.
 */
function ServerWebPaneView({
  paneId,
  webUrl,
  webProfile,
}: {
  paneId: string;
  webUrl: string;
  webProfile: string;
}) {
  const available = useStore((s) => s.webEnv?.capabilities.webPane === true);
  const envKnown = useStore((s) => s.webEnv !== null);
  const frame = useStore((s) => s.webPaneFrames[paneId]);
  const error = useStore((s) => s.webPaneErrors[paneId]);
  const connected = useStore((s) => s.connected);

  const [urlText, setUrlText] = useState('');
  const urlFocusedRef = useRef(false);
  useEffect(() => {
    if (!urlFocusedRef.current) setUrlText(frame?.url || webUrl || '');
  }, [frame?.url, webUrl]);

  // Open (or re-attach) the server-side browser whenever the binding is known.
  // webpane_open is idempotent per pane+profile server-side, so remounts from
  // input-mode cycling just re-sync instead of relaunching.
  useEffect(() => {
    if (!available || !connected || !webProfile) return;
    sendCommand('webpane_open', {
      pane_id: paneId,
      url: webUrl || 'about:blank',
      profile: webProfile,
    });
  }, [available, connected, paneId, webUrl, webProfile]);

  const navigate = useCallback(
    (url: string) => sendCommand('webpane_navigate', { pane_id: paneId, url }),
    [paneId]
  );

  // ── Driving the page (E-16) ───────────────────────────────────────────────
  // The frame is a picture of a LIVE page, so pointer and key events go back
  // over /ws as `webpane_input`; the server replays them into the headless
  // browser and answers with a fresh frame. The client scales nothing — it
  // reports the point in the rendered image's own space plus that image's
  // measured size, and the server maps into source space (utils/webPaneInput).
  const imgRef = useRef<HTMLImageElement>(null);
  const lastMoveRef = useRef(0);
  const showsFrame = !error && !!frame?.screenshot;

  const sendPointer = useCallback(
    (
      kind: 'click' | 'scroll' | 'move',
      e: { clientX: number; clientY: number },
      extra?: Record<string, unknown>
    ): boolean => {
      const el = imgRef.current;
      if (!el) return false;
      const params = pointerAt(paneId, kind, e, el.getBoundingClientRect());
      if (!params) return false;
      sendCommand('webpane_input', { ...params, ...extra });
      return true;
    },
    [paneId]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      // Focus the frame itself so the NEXT keystroke has somewhere to land.
      // (Click still bubbles: the pane grid focuses the pane on the same click.)
      imgRef.current?.focus();
      sendPointer('click', e, { button: buttonName(e.button), modifiers: modifiersOf(e) });
    },
    [sendPointer]
  );

  const handleAuxClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      // Right-click arrives here too; onContextMenu owns it (it also has to
      // suppress the local menu), so only the middle button is handled here.
      if (e.button !== 1) return;
      e.preventDefault();
      sendPointer('click', e, { button: 'middle', modifiers: modifiersOf(e) });
    },
    [sendPointer]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      // The page's own context menu, not this browser's menu for an image.
      e.preventDefault();
      imgRef.current?.focus();
      sendPointer('click', e, { button: 'right', modifiers: modifiersOf(e) });
    },
    [sendPointer]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const now = Date.now();
      if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return;
      if (sendPointer('move', e)) lastMoveRef.current = now;
    },
    [sendPointer]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLImageElement>) => {
      // The multiplexer chords stay with the multiplexer — a surface that
      // swallows the whole keyboard has no way back out (mirrors PaneBox's
      // treatment of an interactive PTY).
      if (isMuxChord(e)) return;
      if (!isForwardableKey(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      sendCommand('webpane_input', {
        pane_id: paneId,
        kind: 'key',
        key: e.key,
        modifiers: modifiersOf(e),
      });
    },
    [paneId]
  );

  useEffect(() => {
    const el = imgRef.current;
    if (!el || !showsFrame) return;
    // Wheel is bound natively and non-passive on purpose: React registers its
    // root wheel listener as passive, where preventDefault is a silent no-op —
    // the pane would scroll its own container while the page never moved.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      sendPointer('scroll', e, { delta_x: e.deltaX, delta_y: e.deltaY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [showsFrame, sendPointer]);

  if (!available) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666] p-5 text-center">
        <div>
          <div className="text-lg mb-2">Web panes require the Rysh desktop app</div>
          <div className="text-sm text-[#555]">
            {envKnown
              ? 'This rysh server cannot drive a server-side browser (no Chromium available), so embedded pages are desktop-only here.'
              : 'This rysh server does not offer server-side web panes.'}{' '}
            Use <code className="bg-[#333] px-1 rounded">##web &lt;url&gt;</code> in the desktop app to embed websites in panes.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="web-pane-container">
      {/* Navigation toolbar — same gestures as the desktop pane, executed by
          the server-side browser. */}
      <div className="web-pane-toolbar">
        <button onClick={() => sendCommand('webpane_back', { pane_id: paneId })} title="Back">
          &#9664;
        </button>
        <button onClick={() => sendCommand('webpane_forward', { pane_id: paneId })} title="Forward">
          &#9654;
        </button>
        <button onClick={() => sendCommand('webpane_reload', { pane_id: paneId })} title="Reload">
          &#8635;
        </button>
        <span
          className="whitespace-nowrap text-[9px] uppercase tracking-wider text-[#5fafaf] select-none"
          title="This page runs in a server-side browser; the pane shows a live view (~1 frame/s)."
        >
          server view
        </span>
        <input
          type="text"
          className="web-pane-url-bar"
          value={urlText}
          placeholder="Enter URL..."
          onChange={(e) => setUrlText(e.target.value)}
          onFocus={() => { urlFocusedRef.current = true; }}
          onBlur={() => { urlFocusedRef.current = false; setUrlText(frame?.url || webUrl || ''); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              const url = urlText.trim();
              if (url) {
                const fullUrl = /^[a-z]+:\/\//i.test(url) || url.startsWith('about:')
                  ? url
                  : `https://${url}`;
                navigate(fullUrl);
                (e.target as HTMLInputElement).blur();
              }
            }
          }}
        />
      </div>

      {/* Frame area: latest server-side screenshot, or the current state. */}
      <div className="flex-1 min-h-0 overflow-auto bg-[#101010] flex items-start justify-center">
        {error ? (
          <div className="p-5 text-center text-[13px] text-[#ff8787] max-w-[560px]">{error}</div>
        ) : frame?.screenshot ? (
          <img
            ref={imgRef}
            src={`data:image/jpeg;base64,${frame.screenshot}`}
            alt={frame.title || 'server-side web pane'}
            className="max-w-full h-auto outline-none"
            draggable={false}
            tabIndex={0}
            title="Click to focus, then type — input is forwarded to the page"
            onClick={handleClick}
            onAuxClick={handleAuxClick}
            onContextMenu={handleContextMenu}
            onMouseMove={handleMouseMove}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <div className="p-5 text-[13px] text-[#666]">starting server-side browser…</div>
        )}
      </div>

      {/* Title bar */}
      {frame?.title && (
        <div className="px-2 py-0.5 text-[#808080] text-[11px] border-t border-[#333] bg-[#1a1a1a] truncate">
          {frame.title}
        </div>
      )}
    </div>
  );
}
