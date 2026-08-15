import { useEffect, useRef } from 'react';
import { useStore, markWebActivated, markWebDeactivated } from '../store';
import { sendCommand } from '../utils/commands';
import { resolveCompletionResult } from '../utils/completion';
import { wsAuthQuery } from '../utils/auth';

/**
 * Manages the WebSocket lifecycle: connect, receive snapshots/approvals,
 * auto-reconnect on close. In Electron, connects to the sidecar port.
 */
export function useWebSocket() {
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Coalesce per-pane output deltas to one store update per animation frame so a
  // bursty stream (e.g. an LLM response) doesn't thrash React.
  const pendingRef = useRef<Record<string, Record<string, string>>>({});
  // Chat-mode deltas are ALSO queued with their turn_id (orchestrator run ID)
  // preserved, so the Ask Rysh transcript can accumulate per-turn entries
  // instead of slicing one capped stream by char offsets. Consecutive chunks of
  // the same turn merge here to keep the queue small under bursty streaming.
  const pendingChatRef = useRef<Record<string, { turnId: string; text: string }[]>>({});
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let unmounted = false;

    const flushPending = () => {
      rafRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = {};
      const pendingChat = pendingChatRef.current;
      pendingChatRef.current = {};
      const store = useStore.getState();
      for (const paneId in pending) {
        for (const mode in pending[paneId]) {
          store.appendPaneOutput(paneId, mode, pending[paneId][mode]);
        }
      }
      for (const paneId in pendingChat) {
        for (const chunk of pendingChat[paneId]) {
          store.appendChatTurn(paneId, chunk.turnId, chunk.text);
        }
      }
    };

    function connect() {
      const sidecarPort = useStore.getState().sidecarPort;

      // In Electron, no sidecar port means there's no active session (e.g. after
      // Detach Session). Don't open a doomed browser-mode socket — retry quietly
      // until a workspace is opened and a port is set, then connect to it.
      if (window.electronAPI && !sidecarPort) {
        reconnectTimerRef.current = setTimeout(connect, 2000);
        return;
      }

      let wsUrl: string;
      if (window.electronAPI && sidecarPort) {
        // Electron mode: connect to sidecar on localhost (content-plane
        // stream). No credential to present: the app's daemons run in control
        // mode — loopback-only, no login — and that is the only kind it talks
        // to over this socket.
        wsUrl = `ws://127.0.0.1:${sidecarPort}/ws?stream=1`;
      } else {
        // Browser mode: use page origin (content-plane stream).
        //
        // The login JWT lives in localStorage, and a browser cannot set
        // headers on a WebSocket handshake, so it goes in the query string,
        // which the server accepts for exactly this reason.
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${proto}//${location.host}/ws?stream=1${wsAuthQuery()}`;
      }

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (unmounted) { ws.close(); return; }
        useStore.getState().setConnected(true);
        useStore.getState().setWs(ws);
        // A new connection holds no pane size claims on the daemon — the old
        // ones were released when the previous socket closed. Anything that
        // reported a size has to report it again, or this window silently
        // stops constraining the panes it is showing.
        useStore.getState().bumpWsEpoch();
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          const store = useStore.getState();
          switch (msg.type) {
            case 'snapshot':
              store.setSnapshot(msg.data, msg.layout_only);
              break;
            // Seed batches: the server used to send one full snapshot, which on a
            // large workspace could not be written inside the socket's write
            // deadline over a tunnel and left this UI permanently blank. Content
            // now arrives as byte-bounded batches after a layout-only snapshot.
            case 'pane_content':
              if (Array.isArray(msg.data?.panes)) store.applyPaneContentSeed(msg.data.panes);
              break;
            case 'pane_output': {
              const d = msg.data;
              if (d?.pane_id && d?.mode && typeof d.text === 'string' && d.text) {
                if (!pendingRef.current[d.pane_id]) pendingRef.current[d.pane_id] = {};
                pendingRef.current[d.pane_id][d.mode] =
                  (pendingRef.current[d.pane_id][d.mode] || '') + d.text;
                // Chat chunks additionally queue turn-tagged for the Ask Rysh
                // per-turn transcript (the flat buffer above still feeds the
                // chat-mode pane view). '' = untagged legacy append.
                if (d.mode === 'chat') {
                  const q = pendingChatRef.current[d.pane_id] || (pendingChatRef.current[d.pane_id] = []);
                  const turnId = typeof d.turn_id === 'string' ? d.turn_id : '';
                  const last = q[q.length - 1];
                  if (last && (turnId === '' || last.turnId === turnId)) last.text += d.text;
                  else q.push({ turnId, text: d.text });
                }
                if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushPending);
              }
              break;
            }
            case 'pane_vt':
              if (msg.data?.pane_id) store.setPaneVT(msg.data.pane_id, msg.data);
              break;
            case 'completion_result':
              // W7: reply to a completion_get this client sent (request/reply
              // over the same socket; correlated by request_id).
              resolveCompletionResult(msg.data || {});
              break;
            case 'board_result': {
              // The agents board (design 025/028): the answer to a board_get
              // this client sent, for one shell-less board pane. Stored as it
              // arrived — error and threads are mutually exclusive and the view
              // renders whichever came, so nothing is normalised away here.
              const d = msg.data;
              if (d?.pane_id) {
                store.setBoardData({
                  paneId: d.pane_id,
                  board: d.board || '',
                  threads: d.threads,
                  roster: d.roster,
                  stats: d.stats,
                  filtered: d.filtered,
                  withheld: d.withheld,
                  roster_reconciled: d.roster_reconciled,
                  error: d.error,
                  no_recorder: d.no_recorder,
                  fetchedAt: Date.now(),
                });
              }
              break;
            }
            case 'webpane_frame':
              // W12: a server-driven web pane pushed a fresh frame (url/title +
              // JPEG screenshot) for browser-mode rendering.
              if (msg.data?.pane_id) {
                store.setWebPaneFrame({
                  paneId: msg.data.pane_id,
                  url: msg.data.url || '',
                  title: msg.data.title || '',
                  screenshot: msg.data.screenshot || '',
                  sourceWidth: msg.data.source_width || 0,
                  sourceHeight: msg.data.source_height || 0,
                });
              }
              break;
            case 'webpane_error':
              // W12 fail-visible: surface server-side web-pane failures in the
              // pane instead of silently showing nothing.
              if (msg.data?.pane_id) {
                store.setWebPaneError(msg.data.pane_id, msg.data.error || 'web pane error');
              }
              break;
            case 'approval_request':
              store.setPendingApproval(msg.data);
              store.setApprovalError(null);
              store.setMode('approval');
              break;
            case 'clipboard_content':
              // Reply to this client's clipboard_copy (§2.8) — targeted, not a
              // broadcast. The asking component correlates on request_id and
              // ignores anything that is not its own.
              store.setClipboardResult({
                requestId: msg.data?.request_id || '',
                paneId: msg.data?.pane_id || '',
                source: msg.data?.source || '',
                text: msg.data?.text || '',
                truncated: !!msg.data?.truncated,
                err: msg.data?.err || '',
              });
              break;
            case 'approval_error':
              // The server refused an answer (malformed, no pane_id, or a
              // decision it does not recognise). Fail-visible: submitApproval
              // has already closed the dialog, so without this the phone shows
              // "answered" while the tool stays blocked to its timeout.
              store.setApprovalError(msg.data?.error || 'the approval was not delivered');
              break;
            case 'agent_list':
              store.setAgentList(msg.data || []);
              break;
            case 'humanoid_list':
              store.setHumanoidList(msg.data || []);
              break;
            // --- Control dashboard frames (design 005 / R1) ---
            // The Go relay in server_control.go has been pushing these since
            // the control plane shipped; before R1 the renderer dropped them.
            case 'control_status':
              store.setControlEnabled(!!msg.data?.control);
              break;
            case 'pairing_list':
              store.setPairingState(msg.data.humanoid_name, {
                pending: msg.data.pending || [],
                allowlist: msg.data.allowlist || [],
              });
              break;
            case 'pairing_request':
              store.addPendingPairing(msg.data);
              break;
            case 'pairing_qr':
              store.setPairingQR(msg.data);
              break;
            case 'pairing_status':
              store.setPairingStatus(msg.data);
              break;
            case 'share_list':
              store.setShareList(msg.data || []);
              break;
            case 'email_list':
              // Response to email_list/email_refresh: an inbox listing (or error)
              // for a humanoid's email view.
              if (msg.data?.humanoid_name) {
                if (msg.data.err) store.setEmailError(msg.data.humanoid_name, msg.data.err);
                else store.setEmailList(msg.data.humanoid_name, msg.data.emails || []);
              }
              break;
            case 'email_detail':
              // Response to email_read: one email's full content (or error).
              if (msg.data?.humanoid_name && msg.data.email) {
                store.setEmailDetail(msg.data.humanoid_name, msg.data.email);
              } else if (msg.data?.humanoid_name && msg.data?.err) {
                store.setEmailError(msg.data.humanoid_name, msg.data.err);
              }
              break;
            case 'email_inbox_changed':
              // New mail arrived. Refresh only if the email client for this
              // humanoid has been opened this session (we have a cached listing),
              // so we don't trigger IMAP fetches for unopened views.
              if (msg.data?.humanoid_name && store.emailList[msg.data.humanoid_name] !== undefined) {
                sendCommand('email_list', { humanoid_name: msg.data.humanoid_name });
              }
              break;
            case 'whatsapp_list':
              if (msg.data?.humanoid_name) {
                if (msg.data.err) store.setWhatsAppError(msg.data.humanoid_name, msg.data.err);
                else store.setWhatsAppList(msg.data.humanoid_name, msg.data.messages || []);
              }
              break;
            case 'whatsapp_detail':
              if (msg.data?.humanoid_name && msg.data.message) {
                store.setWhatsAppDetail(msg.data.humanoid_name, msg.data.message);
              } else if (msg.data?.humanoid_name && msg.data?.err) {
                store.setWhatsAppError(msg.data.humanoid_name, msg.data.err);
              }
              break;
            case 'whatsapp_inbox_changed':
              // New WhatsApp message arrived; refresh only if this humanoid's view
              // has been opened this session.
              if (msg.data?.humanoid_name && store.whatsappList[msg.data.humanoid_name] !== undefined) {
                sendCommand('whatsapp_list', { humanoid_name: msg.data.humanoid_name });
              }
              break;
            case 'pipeline_output':
              if (msg.data?.tab_id && msg.data?.text) {
                store.appendPipelineOutput(msg.data.tab_id, msg.data.text);
              }
              break;
            case 'web_prompt':
              // A prompt was sent to a web pane's AI from outside the chat box
              // (`##mode web ai <prompt>`). Record it as a turn so it shows as a
              // human bubble in the Ask Rysh panel, just like a chat-box prompt.
              if (msg.data?.pane_id && msg.data?.prompt) {
                store.addBrowserPrompt(msg.data.pane_id, msg.data.prompt);
              }
              break;
            case 'web_activate':
              // `##mode new web` enabled web on a pane — switch its display to
              // web mode immediately (deterministic; doesn't wait for the app to
              // notice the snapshot's web_activate_seq bump). markWebActivated
              // opens a grace window so a stale layout-only snapshot arriving
              // right after this push can't clamp the pane back to shell.
              if (msg.data?.pane_id) {
                markWebActivated(msg.data.pane_id);
                // The push carries the binding (profile + url) so the embedded
                // browser can be created/navigated without depending on a snapshot
                // (which can arrive stale, leaving the browser blank).
                store.setWebBinding(msg.data.pane_id, msg.data.profile || '', msg.data.url || '');
                store.setInputMode(msg.data.pane_id, 'web');
              }
              break;
            case 'web_deactivate':
              // `##mode delete web` disabled web on a pane — drop its display back
              // to shell immediately (deterministic; mirrors web_activate so web
              // display is fully push-driven and never inferred from a snapshot).
              if (msg.data?.pane_id) {
                markWebDeactivated(msg.data.pane_id);
                store.clearWebBinding(msg.data.pane_id);
                store.setInputMode(msg.data.pane_id, 'shell');
                // W12: in browser mode also tear down the pane's server-side
                // browser (the Electron path GCs its native view via syncAlive).
                if (!window.electronAPI) {
                  sendCommand('webpane_close', { pane_id: msg.data.pane_id });
                }
              }
              break;
            case 'import_cookies':
              // `##web import-google-session` extracted a Google login from a
              // real-Chrome jar and sent the cookies here; write them into the
              // profile's persistent session partition so web panes on it carry
              // the Google session (for third-party "Sign in with Google").
              // Profile-scoped, not pane-scoped — no store/display change.
              if (msg.data?.profile && Array.isArray(msg.data?.cookies) && window.electronAPI) {
                window.electronAPI.webPane
                  .importCookies(msg.data.profile, msg.data.cookies)
                  .catch((e: unknown) => console.error('[web] importCookies failed:', e));
              }
              break;
            case 'browser_action': {
              // The AI's browser_action tool requested a DOM action on a web
              // pane. Execute it on the embedded WebContentsView (main process)
              // and reply with browser_result, which the sidecar routes back to
              // the waiting tool. Mirrors the approval_request round trip.
              const d = msg.data;
              const req = d?.request;
              if (d?.pane_id && req?.request_id && req?.action) {
                const reply = (r: { success: boolean; result?: unknown; error?: string; screenshot?: string }) =>
                  sendCommand('browser_result', {
                    pane_id: d.pane_id,
                    request_id: req.request_id,
                    success: r.success,
                    result: r.result ?? null,
                    error: r.error || '',
                    screenshot: r.screenshot || '',
                  });
                if (window.electronAPI) {
                  window.electronAPI.webPane
                    .executeAction(d.pane_id, req.action, req.params || {})
                    .then(reply)
                    .catch((e: unknown) =>
                      reply({ success: false, error: e instanceof Error ? e.message : String(e) })
                    );
                } else {
                  reply({ success: false, error: 'browser actions require the Rysh desktop app' });
                }
              }
              break;
            }
          }
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onclose = () => {
        if (unmounted) return;
        useStore.getState().setConnected(false);
        useStore.getState().setWs(null);
        reconnectTimerRef.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    // In Electron, wait for sidecar port to be set before connecting
    if (window.electronAPI) {
      const checkPort = () => {
        const port = useStore.getState().sidecarPort;
        if (port) {
          connect();
        } else {
          setTimeout(checkPort, 200);
        }
      };
      checkPort();
    } else {
      connect();
    }

    return () => {
      unmounted = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      const ws = useStore.getState().ws;
      if (ws) ws.close();
    };
  }, []);
}
