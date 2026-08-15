import { create } from 'zustand';
import type { WorkspaceSnapshot, TabSnapshot, PaneSnapshot, PaneSeed, PendingApproval, AppMode, InputMode, WebPaneStatus, WebEnv, WebPaneFrame, BoardData, ClipboardContent, AgentInfo, HumanoidInfo, ShareInfo, EmailSummary, EmailDetail, WhatsAppMsgSummary, WhatsAppMsgDetail, PairingState, PairingQR, PairingStatusInfo, DashboardTab, PendingPair } from './types';
import { FIXED_INPUT_MODES } from './types';

// Tracks the last-seen web_profile per pane so setSnapshot can auto-activate web
// mode exactly when a pane's web binding first appears (##mode new web) — without
// fighting later manual mode cycling. Module-level/non-reactive; resets on reload.
const lastWebProfile = new Map<string, string>();

// Tracks the last-seen web_activate_seq per pane. `##mode new web` bumps the seq
// on every invocation (even same profile/url), so a change here is the explicit
// "show & rebind the browser now" signal — it switches the pane back to web even
// when the binding is unchanged and the pane was showing another display mode.
const lastWebActivateSeq = new Map<string, number>();

// Web display is push-driven: the backend sends `web_activate` / `web_deactivate`
// pushes (see useWebSocket.ts) that flip a pane's display on/off web immediately,
// independent of snapshots. webActivatedAt records when a pane was last activated
// so setSnapshot can apply a grace window: a layout-only snapshot can lag the
// `web_activate` push by ~17ms and still carry the pane's PRE-enable state (no
// web_profile, web missing from enabled_modes). Clamping web→shell on that stale
// frame was the auto-switch bug. Within WEB_ACTIVATE_GRACE_MS of an activation we
// never clamp web→shell, so the stale frame is ignored until the correct snapshot
// (or the deterministic web_deactivate push) arrives. Module-level/non-reactive;
// resets on reload.
const webActivatedAt = new Map<string, number>();
const WEB_ACTIVATE_GRACE_MS = 3000;

// markWebActivated opens the grace window for a pane (called from the
// `web_activate` push handler). markWebDeactivated closes it (called from the
// `web_deactivate` push handler) so a later snapshot can clamp normally.
export function markWebActivated(paneId: string): void {
  webActivatedAt.set(paneId, Date.now());
}
export function markWebDeactivated(paneId: string): void {
  webActivatedAt.delete(paneId);
}

// findPane walks the snapshot tree to locate a pane by id (used to anchor the
// predictive-echo overlay at the pane's current cursor, and to pre-fill the
// rename input with a pane's existing given-name).
export function findPane(snapshot: WorkspaceSnapshot | null, paneId: string): PaneSnapshot | null {
  if (!snapshot) return null;
  for (const tab of snapshot.tabs || []) {
    for (const lane of tab.lanes || []) {
      for (const g of lane.pane_groups || []) {
        for (const p of g.panes || []) {
          if (p.id === paneId) return p;
        }
      }
    }
  }
  return null;
}

// visiblePaneIDs collects every pane id rendered by a tab (all lanes, all
// groups — including the collapsed members of a stack, which are on screen as
// title bars). Used to tell "my focused pane is gone / on another tab" from
// "the daemon simply moved its own focus somewhere else".
function visiblePaneIDs(tab: TabSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const lane of tab.lanes || []) {
    for (const g of lane.pane_groups || []) {
      for (const p of g.panes || []) ids.add(p.id);
    }
  }
  return ids;
}

/**
 * resolveFocus decides which pane THIS window focuses after a snapshot.
 *
 * Focus is client-owned here, not daemon-owned. The daemon moves
 * `active_pane_id` for reasons that have nothing to do with the person at this
 * keyboard: an agent spawns a pane, a background job finishes, another client
 * clicks. Following those moves yanked the cursor out from under someone
 * mid-sentence — you type into pane 1, an agent in pane 2 creates a child, and
 * the rest of your line lands in pane 2. Every keystroke this app sends is
 * addressed to an explicit pane id (see useKeyboard/PaneInput), so nothing
 * requires the daemon and this window to agree on focus.
 *
 * So: the daemon's focus is adopted only when the user asked for a move here.
 * Directional navigation (focus_pane_left, stacked_pane_next, focus_tab_index,
 * create_pane …) can't be resolved client-side — only the daemon knows the
 * layout well enough to say where "left" lands — so sendCommand arms a short
 * follow window and the first daemon focus CHANGE inside it wins. A click needs
 * no window: it names its pane outright.
 */
export function resolveFocus(
  s: WorkspaceSnapshot,
  focused: string | null,
  followUntil: number,
  now: number
): { focusedPaneID: string | null; followDaemonUntil: number } {
  const daemon = s.active_pane_id || '';
  // Nothing focused yet (first snapshot, or after Detach): seed from the daemon.
  if (!focused) return { focusedPaneID: daemon || null, followDaemonUntil: 0 };

  const tab = (s.tabs || []).find((t) => t.id === s.active_tab_id) || (s.tabs || [])[0];
  const visible = tab ? visiblePaneIDs(tab) : new Set<string>();
  // The focused pane is not on screen — it was closed, or the visible tab
  // changed. Either way it cannot take keystrokes, so the daemon's choice is
  // the only sane answer.
  //
  // An EMPTY set means the snapshot carried no panes at all (a degraded or
  // placeholder frame — a timed-out cascade leg). That is missing information,
  // not evidence that the pane is gone, so it must not move focus.
  if (visible.size > 0 && !visible.has(focused)) {
    return { focusedPaneID: daemon || focused, followDaemonUntil: 0 };
  }

  // Armed by a user-issued focus-moving command. Adopt the first CHANGE and
  // disarm; an unchanged id means the daemon hasn't acted yet, so keep waiting
  // until the window lapses (rather than burning the arm on a stale frame).
  if (followUntil > now && daemon && daemon !== focused) {
    return { focusedPaneID: daemon, followDaemonUntil: 0 };
  }

  return { focusedPaneID: focused, followDaemonUntil: followUntil > now ? followUntil : 0 };
}

// paneCursor returns a pane's current VT cursor (raw or remote-interactive).
function paneCursor(p: PaneSnapshot): { row: number; col: number } {
  if (p.remote_interactive) {
    return { row: p.remote_vt_cursor_row || 0, col: p.remote_vt_cursor_col || 0 };
  }
  return { row: p.vt_cursor_row || 0, col: p.vt_cursor_col || 0 };
}

// PREDICTIVE_ECHO_ENABLED gates the Mosh-style predictive local echo (predictEcho
// / backspaceEcho). When disabled the renderer shows ONLY the authoritative VT
// stream from the (sidecar / remote) source — paneEcho stays empty so VTScreen's
// overlay never draws.
//
// Predictive echo masks keystroke round-trip latency, but the rysh data plane is
// now fast enough (single-digit-ms over the local sidecar socket / LAN) that there
// is little latency left to mask. Meanwhile the simple heuristic here — "every
// printable key echoes at the cursor" — is wrong for non-echoing input: vim
// normal-mode commands (i, :, <esc>, wq), pagers, and password prompts are NOT
// echoed at the cursor, so the predicted glyph lingers there until a later frame
// reconciles it (or forever, if the program then idles), producing duplicate
// characters when typing into an interactive pane. Mirrors rysh-cli 6ab69d8
// (disable Mosh-style predictive echo) in the mirror tab listener.
//
// Re-enable only with a confidence/epoch model (à la Mosh, which predicts only
// when sure the byte will echo) or behind a config flag for genuinely high-latency
// remote shares. The machinery below (paneEcho, reconcile, VTScreen overlay) is
// left intact for that.
const PREDICTIVE_ECHO_ENABLED: boolean = false;

// Per-pane content/VT accumulated client-side from the content-plane streams
// (?stream=1): the layout-only snapshot omits these, so the renderer rehydrates
// panes from these maps before display.
export type PaneContentBuf = {
  output: string; aiOutput: string; ryshOutput: string; chatOutput: string; externalOutput: string;
  // Live buffers for dynamic per-humanoid modes, keyed by mode (humanoid) name,
  // e.g. "slack-bot". Seeded from the snapshot's mode_outputs and accumulated
  // from pane_output deltas whose mode is not one of the fixed modes.
  modeOutputs?: Record<string, string>;
};
export type PaneVTBuf = {
  raw_mode?: boolean; vt_screen?: string[]; vt_cursor_row?: number; vt_cursor_col?: number;
  remote_interactive?: boolean; remote_vt_screen?: string[]; remote_vt_cursor_row?: number; remote_vt_cursor_col?: number;
};

const MAX_PANE_CONTENT = 20000;
// Ask Rysh transcript: max retained AI turns per pane. Older turns are dropped
// whole (bumping the pane's chatTurns.base) so live turn indices never shift.
const MAX_CHAT_TURNS = 200;
function capTail(s: string): string {
  if (s.length <= MAX_PANE_CONTENT) return s;
  const t = s.slice(s.length - MAX_PANE_CONTENT);
  const i = t.indexOf('\n');
  return i >= 0 && i < t.length - 1 ? t.slice(i + 1) : t;
}

// seedContent extracts per-pane content + VT from a full snapshot (used to seed
// the stores on connect / on any full snapshot).
function seedContent(s: WorkspaceSnapshot): { content: Record<string, PaneContentBuf>; vt: Record<string, PaneVTBuf> } {
  const content: Record<string, PaneContentBuf> = {};
  const vt: Record<string, PaneVTBuf> = {};
  for (const tab of s.tabs || []) {
    for (const lane of tab.lanes || []) {
      for (const g of lane.pane_groups || []) {
        for (const p of g.panes || []) {
          content[p.id] = {
            output: p.output || '', aiOutput: p.ai_output || '', ryshOutput: p.rysh_output || '',
            chatOutput: p.chat_output || '', externalOutput: p.external_output || '',
            modeOutputs: { ...(p.mode_outputs || {}) },
          };
          vt[p.id] = {
            raw_mode: p.raw_mode, vt_screen: p.vt_screen, vt_cursor_row: p.vt_cursor_row, vt_cursor_col: p.vt_cursor_col,
            remote_interactive: p.remote_interactive, remote_vt_screen: p.remote_vt_screen,
            remote_vt_cursor_row: p.remote_vt_cursor_row, remote_vt_cursor_col: p.remote_vt_cursor_col,
          };
        }
      }
    }
  }
  return { content, vt };
}

interface AppStore {
  // Server-driven state
  snapshot: WorkspaceSnapshot | null;
  connected: boolean;
  pendingApproval: PendingApproval | null;
  // The server refused an approval answer (approval_error). Held separately
  // from pendingApproval because submitApproval clears the dialog optimistically
  // — by the time a refusal arrives there is nothing left on screen to attach
  // it to, and on a phone an unshown refusal is indistinguishable from success.
  approvalError: string | null;
  // The most recent clipboard_content reply. The component that asked keeps its
  // request id and ignores anything else — replies are per-connection, and a
  // second copy started elsewhere must not hijack the first one's sheet.
  clipboardResult: ClipboardContent | null;
  ws: WebSocket | null;

  // Client-side UI state
  mode: AppMode;
  paneInputModes: Record<string, InputMode>;
  paneInputTexts: Record<string, string>;
  paneScrollLocked: Record<string, boolean>;
  paneHistoryIdx: Record<string, number>;
  paneHistorySaved: Record<string, string>;
  // paneHistoryPrefix: non-empty → Up/Down only visit history entries with
  // this prefix (bash history-search-backward; armed on Up with a draft).
  paneHistoryPrefix: Record<string, string>;
  // panePendingCmd accumulates the lines of a syntactically incomplete shell
  // command (PS2 continuation) until it completes and submits as one entry.
  panePendingCmd: Record<string, string>;
  fullscreenPaneID: string | null;
  /**
   * The pane THIS window considers focused — client-owned, and the single
   * source of truth for where keystrokes go and which pane draws the accent
   * border. Only user intent moves it (a click, or a navigation command this
   * window sent); daemon-side focus churn does not. null = not seeded yet, fall
   * back to the daemon. See resolveFocus.
   */
  focusedPaneID: string | null;
  /**
   * While Date.now() < followDaemonUntil, the next daemon focus CHANGE is
   * adopted. Armed by sendCommand for the commands whose landing pane only the
   * daemon can compute (directional nav, stack rotation, tab switch, create).
   */
  followDaemonUntil: number;
  escCount: number;
  escTimer: ReturnType<typeof setTimeout> | null;
  renameText: string;
  renamePaneID: string | null;

  // Side panel state
  showAgentPanel: boolean;
  showHumanoidPanel: boolean;
  showSharePanel: boolean;

  // Web pane state
  webPaneStatuses: Record<string, WebPaneStatus>;

  // Per-pane web binding (profile + url) delivered by the `web_activate` push.
  // This is the authoritative source for creating/navigating the embedded
  // browser: it arrives deterministically with the activation, unlike the
  // snapshot's web_profile/web_url which can lag and arrive stale (leaving the
  // browser blank). WebPaneView prefers this and falls back to the snapshot only
  // for restore-on-startup (when no push happened this session).
  webBindings: Record<string, { profile: string; url: string }>;

  // --- Web (browser) mode: server-reported environment (roadmap W9) ---
  // Fetched once from GET /api/env when running without electronAPI. This is
  // the authoritative "I am the web build" signal plus what the server can do
  // (completion / voice / server-side web panes), replacing feature-sniffing.
  // null = Electron, or /api/env not (yet) answered.
  webEnv: WebEnv | null;

  // Server-side web-pane stream (roadmap W12): latest frame + visible error
  // per pane, pushed by the server over /ws as webpane_frame / webpane_error.
  webPaneFrames: Record<string, WebPaneFrame>;
  webPaneErrors: Record<string, string>;

  // Agents board (design 025 / 028), keyed by the pane rendering it. Keyed by
  // PANE and not by board id because two panes can render the same board and
  // one window can show several boards at once; the pane is what the answer is
  // correlated back to.
  boardData: Record<string, BoardData>;

  // Agent / Humanoid / Share panel data
  agentList: AgentInfo[];
  humanoidList: HumanoidInfo[];

  // --- Control dashboard (design 005 / R1) ---
  // controlEnabled mirrors the server's RYSH_WEB_CONTROL gate: mutating
  // buttons only render when it is true. The server rejects mutations
  // independently, so this is UX, never the security boundary.
  controlEnabled: boolean;
  showDashboard: boolean;
  dashboardTab: DashboardTab;
  pairings: Record<string, PairingState>; // humanoid name → pending + allowlist
  pairingQRs: Record<string, PairingQR>; // `${humanoid}:${channel}` → QR payload
  pairingStatuses: Record<string, PairingStatusInfo>; // `${humanoid}:${channel}` → link status
  shareList: ShareInfo[];

  // Pipeline output accumulator (keyed by tab ID)
  pipelineOutputs: Record<string, string>;

  // Ask Rysh (browser-agent) transcript turns, keyed by pane ID. Kept in the
  // store (not the component) so the conversation survives cycling the pane's
  // input mode away from web and back (which remounts the panel). Each turn
  // records the user's prompt and the ABSOLUTE index (base + entries.length of
  // chatTurns at submit time) of the first AI chat turn that belongs to it.
  browserTurns: Record<string, { id: string; prompt: string; ts: number; aiStartTurn: number }[]>;

  // Ask Rysh AI replies, keyed by pane ID: an ordered list of per-run entries
  // (turnId = the orchestrator run ID carried on the chat stream). Streamed
  // chunks append to their own run's entry, so an answer always concatenates
  // chunk1+chunk2+… and can never bleed into another bubble. Capping drops
  // whole oldest entries and bumps `base`, so the absolute indices recorded in
  // browserTurns stay valid forever (unlike char offsets into a front-trimmed
  // string). Lives OUTSIDE paneContent on purpose: a full-snapshot reseed
  // replaces paneContent with the backend's byte-capped buffers, which would
  // invalidate any offsets — this map survives reseeds untouched.
  chatTurns: Record<string, { base: number; entries: { turnId: string; content: string }[] }>;

  // Whether the "Ask Rysh" AI panel is open per web pane. Undefined means "not
  // set yet" and is treated as OPEN — so the panel shows on the right the first
  // time a web pane opens; an explicit false (user closed it) is remembered
  // across input-mode cycling.
  webChatOpen: Record<string, boolean>;

  // ---- Email client (desktop Gmail-style view) ----
  // Inbox listings and fetched details are cached by humanoid name (the email
  // account). Ephemeral view selection (which email is open in a pane) is keyed
  // by pane id, since two panes could show the same humanoid. emailList[h] being
  // undefined means "never fetched"; an empty array means "fetched, empty inbox".
  emailList: Record<string, EmailSummary[]>;
  emailDetails: Record<string, Record<number, EmailDetail>>;
  emailLoading: Record<string, boolean>;
  emailError: Record<string, string>;
  emailSelectedUID: Record<string, number | null>;
  // Whether the in-view "Ask the bot" AI dock is open per pane. Undefined ⇒ open
  // (shown by default the first time); an explicit false is remembered across
  // input-mode cycling (which remounts the view). Mirrors webChatOpen.
  emailChatOpen: Record<string, boolean>;

  // WhatsApp client view state (parallels the email view). Keyed by humanoid name
  // for the data caches; per-pane for the ephemeral selection. Message IDs are
  // strings ("wa-3"), unlike email's numeric UIDs.
  whatsappList: Record<string, WhatsAppMsgSummary[]>;
  whatsappDetails: Record<string, Record<string, WhatsAppMsgDetail>>;
  whatsappLoading: Record<string, boolean>;
  whatsappError: Record<string, string>;
  whatsappSelectedID: Record<string, string | null>;
  whatsappChatOpen: Record<string, boolean>;

  // Predictive local-echo overlay for interactive panes (keyed by pane ID):
  // pending printable chars shown instantly at the cursor while the keystroke
  // round-trips to the (possibly remote) source.
  paneEcho: Record<string, { text: string; row: number; col: number; ts: number }>;

  // Per-pane content/VT accumulated from the content plane (?stream=1). The
  // layout-only snapshot omits these; the renderer rehydrates panes from here.
  paneContent: Record<string, PaneContentBuf>;
  paneVT: Record<string, PaneVTBuf>;

  // Voice prompting state
  voiceConfig: { enabled: boolean; provider: string; hotkey: string; language: string } | null;
  voiceState: 'idle' | 'recording' | 'transcribing' | 'error';
  voiceError: string | null;

  // Electron state
  sidecarPort: number | null;
  /**
   * Increments on every WebSocket open. Panes report their size to the daemon
   * as a per-connection CLAIM (the daemon sizes a pane's PTY to the smallest
   * viewport showing it), and a reconnect is a NEW connection holding no
   * claims — so anything that reported a size has to report it again. Watching
   * this is how usePaneResize knows to re-send a size it would otherwise
   * suppress as unchanged.
   */
  wsEpoch: number;

  // Workspace state
  workspacePath: string | null;
  workspaceName: string | null;

  // Actions
  setSnapshot: (s: WorkspaceSnapshot, layoutOnly?: boolean) => void;
  setConnected: (c: boolean) => void;
  setWs: (ws: WebSocket | null) => void;
  // Drop the active session: close the socket and clear the snapshot/port so the
  // UI shows the empty "no active session" state (used by Detach Session).
  clearSession: () => void;
  setMode: (m: AppMode) => void;
  setPendingApproval: (a: PendingApproval | null) => void;
  setApprovalError: (e: string | null) => void;
  setClipboardResult: (c: ClipboardContent | null) => void;
  cycleInputMode: (paneId: string) => void;
  setInputMode: (paneId: string, mode: InputMode) => void;
  getInputMode: (paneId: string) => InputMode;
  setPaneInputText: (paneId: string, text: string) => void;
  setPaneScrollLocked: (paneId: string, locked: boolean) => void;
  setPaneHistoryIdx: (paneId: string, idx: number) => void;
  setPaneHistorySaved: (paneId: string, text: string) => void;
  setPaneHistoryPrefix: (paneId: string, prefix: string) => void;
  setPanePendingCmd: (paneId: string, cmd: string) => void;
  // clearPaneOutput wipes the locally-streamed merged output for a pane —
  // the renderer half of readline Ctrl+L (the PaneActor clears its own
  // buffers via the pane_clear_output WS command).
  clearPaneOutput: (paneId: string) => void;
  setFullscreenPaneID: (id: string | null) => void;
  /** Explicit user focus (a click, or a tap/select in the mobile UI). */
  focusPane: (id: string | null) => void;
  /** Arm the follow window: let the daemon's next focus change through. */
  armFocusFollow: () => void;
  setEscCount: (count: number) => void;
  setEscTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  setRenameText: (text: string) => void;
  setRenamePaneID: (id: string | null) => void;
  toggleAgentPanel: () => void;
  toggleHumanoidPanel: () => void;
  toggleSharePanel: () => void;
  setAgentList: (agents: AgentInfo[]) => void;
  setHumanoidList: (humanoids: HumanoidInfo[]) => void;
  setControlEnabled: (enabled: boolean) => void;
  toggleDashboard: () => void;
  setDashboardTab: (tab: DashboardTab) => void;
  setPairingState: (humanoid: string, state: PairingState) => void;
  addPendingPairing: (req: PendingPair & { humanoid_name: string }) => void;
  setPairingQR: (qr: PairingQR) => void;
  setPairingStatus: (status: PairingStatusInfo) => void;
  setShareList: (shares: ShareInfo[]) => void;
  appendPipelineOutput: (tabId: string, text: string) => void;
  addBrowserTurn: (paneId: string, turn: { id: string; prompt: string; ts: number; aiStartTurn: number }) => void;
  // Record a prompt that was dispatched to a web pane's AI from outside the chat
  // box (`##mode web ai <prompt>`). Captures the current absolute chat-turn
  // index so the prompt + its reply render as a normal turn in the Ask Rysh panel.
  addBrowserPrompt: (paneId: string, prompt: string) => void;
  // Append a streamed AI chat chunk to its run's entry in chatTurns (creating
  // the entry when a new run ID appears). turnId '' (legacy/plain appends)
  // continues the most recent entry.
  appendChatTurn: (paneId: string, turnId: string, text: string) => void;
  setWebChatOpen: (paneId: string, open: boolean) => void;
  setEmailList: (humanoid: string, emails: EmailSummary[]) => void;
  setEmailDetail: (humanoid: string, email: EmailDetail) => void;
  setEmailLoading: (humanoid: string, loading: boolean) => void;
  setEmailError: (humanoid: string, err: string) => void;
  setEmailSelectedUID: (paneId: string, uid: number | null) => void;
  setEmailChatOpen: (paneId: string, open: boolean) => void;
  setWhatsAppList: (humanoid: string, messages: WhatsAppMsgSummary[]) => void;
  setWhatsAppDetail: (humanoid: string, message: WhatsAppMsgDetail) => void;
  setWhatsAppLoading: (humanoid: string, loading: boolean) => void;
  setWhatsAppError: (humanoid: string, err: string) => void;
  setWhatsAppSelectedID: (paneId: string, id: string | null) => void;
  setWhatsAppChatOpen: (paneId: string, open: boolean) => void;
  predictEcho: (paneId: string, ch: string) => void;
  backspaceEcho: (paneId: string) => void;
  clearEcho: (paneId: string) => void;
  appendPaneOutput: (paneId: string, mode: string, text: string) => void;
  /** Apply one seed batch of per-pane content (see server internal/web/seed.go). */
  applyPaneContentSeed: (panes: PaneSeed[]) => void;
  /**
   * Command history per pane, from the seed. Held here rather than read off the
   * snapshot because layout refreshes deliberately omit histories — a
   * layout-only snapshot carrying them measured 5.8 MB, which cannot be written
   * inside the socket deadline over a tunnel.
   */
  paneHistory: Record<string, { shell: string[]; prompt: string[] }>;
  setPaneVT: (paneId: string, vt: PaneVTBuf) => void;
  setWebPaneStatus: (status: WebPaneStatus) => void;
  setWebEnv: (env: WebEnv | null) => void;
  setWebPaneFrame: (frame: WebPaneFrame) => void;
  setBoardData: (data: BoardData) => void;
  setWebPaneError: (paneId: string, error: string) => void;
  setWebBinding: (paneId: string, profile: string, url: string) => void;
  clearWebBinding: (paneId: string) => void;
  setVoiceConfig: (c: { enabled: boolean; provider: string; hotkey: string; language: string } | null) => void;
  setVoiceState: (s: 'idle' | 'recording' | 'transcribing' | 'error') => void;
  setVoiceError: (e: string | null) => void;
  setSidecarPort: (port: number) => void;
  bumpWsEpoch: () => void;
  setWorkspace: (path: string | null, name: string | null) => void;
  getEffectiveActivePaneID: () => string;
}

// How long a user-issued focus-moving command waits for the daemon to report
// where focus landed. Long enough to survive a daemon busy with PTY churn,
// short enough that an agent creating a pane a moment later is not mistaken for
// the answer to the arrow key you pressed.
export const FOCUS_FOLLOW_WINDOW_MS = 3000;

export const useStore = create<AppStore>((set, get) => ({
  // Initial state
  snapshot: null,
  connected: false,
  pendingApproval: null,
  approvalError: null,
  clipboardResult: null,
  ws: null,
  mode: 'normal',
  paneInputModes: {},
  paneInputTexts: {},
  paneScrollLocked: {},
  paneHistoryIdx: {},
  paneHistorySaved: {},
  paneHistoryPrefix: {},
  panePendingCmd: {},
  fullscreenPaneID: null,
  focusedPaneID: null,
  followDaemonUntil: 0,
  paneHistory: {},
  escCount: 0,
  escTimer: null,
  renameText: '',
  renamePaneID: null,
  showAgentPanel: false,
  showHumanoidPanel: false,
  showSharePanel: false,
  webPaneStatuses: {},
  webBindings: {},
  webEnv: null,
  webPaneFrames: {},
  webPaneErrors: {},
  boardData: {},
  agentList: [],
  humanoidList: [],
  controlEnabled: false,
  showDashboard: false,
  dashboardTab: 'channels',
  pairings: {},
  pairingQRs: {},
  pairingStatuses: {},
  shareList: [],
  pipelineOutputs: {},
  browserTurns: {},
  chatTurns: {},
  webChatOpen: {},
  emailList: {},
  emailDetails: {},
  emailLoading: {},
  emailError: {},
  emailSelectedUID: {},
  emailChatOpen: {},
  whatsappList: {},
  whatsappDetails: {},
  whatsappLoading: {},
  whatsappError: {},
  whatsappSelectedID: {},
  whatsappChatOpen: {},
  paneEcho: {},
  paneContent: {},
  paneVT: {},
  voiceConfig: null,
  voiceState: 'idle',
  voiceError: null,
  sidecarPort: null,
  wsEpoch: 0,
  workspacePath: null,
  workspaceName: null,

  // Actions
  setSnapshot: (s, layoutOnly) => {
    const { focusedPaneID, followDaemonUntil, paneEcho, paneContent: prevContent, paneVT: prevVT, paneInputModes } = get();
    // A full snapshot (re)seeds the per-pane content/VT store; a layout-only one
    // keeps it (content arrives via pane_output / pane_vt deltas).
    let paneContent = prevContent;
    let paneVT = prevVT;
    if (!layoutOnly) {
      const seeded = seedContent(s);
      paneContent = seeded.content;
      paneVT = seeded.vt;
    }
    // Reconcile predictive echoes against the fresh snapshot: drop an echo once
    // the authoritative cursor has advanced to/past where it ends (the source
    // echoed it) or after a 1s safety expiry.
    let nextEcho = paneEcho;
    const ids = Object.keys(paneEcho);
    if (ids.length) {
      const now = Date.now();
      nextEcho = {};
      for (const id of ids) {
        const e = paneEcho[id];
        if (now - e.ts >= 1000) continue; // expired
        const pane = findPane(s, id);
        if (pane) {
          const c = paneCursor(pane);
          if (c.row > e.row || (c.row === e.row && c.col >= e.col + e.text.length)) {
            continue; // source caught up — drop the prediction
          }
        }
        nextEcho[id] = e;
      }
    }
    // Per-pane input-mode reconciliation over the snapshot's panes:
    //  1. Auto-activate "web" when a pane's web binding first appears
    //     (##mode new web) so the embedded browser shows immediately.
    //  2. Clamp a selected mode back to shell if it was disabled (##mode delete).
    let nextModes = paneInputModes;
    const ensureClone = () => {
      if (nextModes === paneInputModes) nextModes = { ...paneInputModes };
    };
    for (const tab of s.tabs || []) {
      for (const lane of tab.lanes || []) {
        for (const g of lane.pane_groups || []) {
          for (const p of g.panes || []) {
            const id = p.id;
            const enabledModes = p.enabled_modes || [];
            // A pane entry with no enabled_modes is incomplete — e.g. a partial
            // or placeholder snapshot (a timed-out cascade leg, or a layout-only
            // entry that didn't carry mode state). Such an entry must NOT drive
            // display-mode changes or pollute the web trackers: doing so used to
            // clamp a web pane back to shell (no 'web' in the empty→default
            // fallback) and then re-force it on the next full snapshot, which
            // flipped a web pane to terminal and back when an unrelated pane was
            // clicked. Skip web reconciliation entirely for incomplete entries.
            if (enabledModes.length === 0) {
              continue;
            }
            const profile = p.web_profile || '';
            const prevProfile = lastWebProfile.get(id) || '';
            const seq = p.web_activate_seq || 0;
            const prevSeq = lastWebActivateSeq.get(id);
            // Activate web when the binding first appears (empty → set), or when
            // `##mode new web` bumped the activate seq (re-run from any display
            // mode, even with the same profile/url). On the very first snapshot
            // (prevSeq undefined) a restored non-zero seq should NOT force web —
            // only a genuine increment while running does.
            const firstBind = profile && !prevProfile;
            const reactivated = prevSeq !== undefined && seq > prevSeq;
            if (firstBind || reactivated) {
              ensureClone();
              nextModes[id] = 'web';
            }
            lastWebProfile.set(id, profile);
            lastWebActivateSeq.set(id, seq);

            // Clamp a selected mode back to shell if it was disabled (##mode
            // delete) and the pane is no longer showing it.
            const cur = nextModes[id];
            if (cur && cur !== 'shell' && !enabledModes.includes(cur)) {
              if (cur === 'web') {
                // Web display is push-driven (web_activate → web, web_deactivate
                // → shell, firstBind → restore-on-startup), so the snapshot is
                // NOT authoritative for switching web off. A layout-only snapshot
                // routinely lags the web_activate push and briefly carries the
                // pane's pre-enable state (no web_profile, web missing from
                // enabled_modes) — clamping on that stale frame is the bug that
                // reverted web→shell ~17ms after activation. Only clamp web→shell
                // as a last-resort fallback (e.g. a web_deactivate push was
                // missed): the binding is fully gone (no web_profile) AND we're
                // outside the grace window after the most recent web_activate.
                const sinceActivate = Date.now() - (webActivatedAt.get(id) ?? 0);
                if (!profile && sinceActivate >= WEB_ACTIVATE_GRACE_MS) {
                  ensureClone();
                  nextModes[id] = 'shell';
                }
              } else {
                ensureClone();
                nextModes[id] = 'shell';
              }
            }
          }
        }
      }
    }

    // Focus never simply mirrors s.active_pane_id — see resolveFocus for why
    // the daemon does not get to move this window's cursor on its own.
    const focus = resolveFocus(s, focusedPaneID, followDaemonUntil, Date.now());

    set({
      snapshot: s,
      paneContent,
      paneVT,
      paneEcho: nextEcho,
      paneInputModes: nextModes,
      focusedPaneID: focus.focusedPaneID,
      followDaemonUntil: focus.followDaemonUntil,
    });
  },

  setConnected: (c) => set({ connected: c }),
  setWs: (ws) => set({ ws }),
  clearSession: () => {
    const ws = get().ws;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    // sidecarPort = null stops useWebSocket from reconnecting to the detached
    // daemon; it resumes automatically when a workspace is opened (port set).
    set({
      snapshot: null,
      connected: false,
      ws: null,
      sidecarPort: null,
      // The focused pane belonged to the session we just dropped; the next
      // session seeds focus from its own first snapshot.
      focusedPaneID: null,
      followDaemonUntil: 0,
    });
  },
  setMode: (m) => set({ mode: m }),
  setPendingApproval: (a) => set({ pendingApproval: a }),
  setApprovalError: (e) => set({ approvalError: e }),
  setClipboardResult: (c) => set({ clipboardResult: c }),

  cycleInputMode: (paneId) =>
    set((state) => {
      const current = state.paneInputModes[paneId] || 'shell';
      // Cycle only modes enabled for this pane (##mode). The backend snapshot's
      // enabled_modes is the source of truth; pre-field snapshots fall back to
      // the default set, so e.g. web is skipped until `##mode new web`.
      const pane = findPane(state.snapshot, paneId);
      const enabledList =
        pane?.enabled_modes && pane.enabled_modes.length > 0
          ? pane.enabled_modes
          : ['shell', 'prompt', 'rysh', 'chat'];
      const enabled = new Set<string>(enabledList);
      // Build the cycle order: the fixed modes first, then any dynamic
      // per-humanoid modes (in enabled_modes but not fixed, e.g. "slack-bot")
      // appended after — mirroring the daemon's nextEnabledMode so double-Escape
      // can actually reach a humanoid mode once it registers output to the pane.
      const order: string[] = [...FIXED_INPUT_MODES];
      for (const e of enabledList) {
        if (!order.includes(e)) order.push(e);
      }
      // external stays hidden until a humanoid registers output (mirror backend).
      if (pane && !pane.external_output) enabled.delete('external');
      const idx = order.indexOf(current);
      for (let i = 1; i <= order.length; i++) {
        const next = order[(idx + i + order.length) % order.length];
        if (enabled.has(next)) {
          return { paneInputModes: { ...state.paneInputModes, [paneId]: next } };
        }
      }
      return {}; // only shell enabled — no change
    }),

  setInputMode: (paneId, mode) =>
    set((state) => ({
      paneInputModes: {
        ...state.paneInputModes,
        [paneId]: mode,
      },
    })),

  getInputMode: (paneId) => get().paneInputModes[paneId] || 'shell',

  setPaneInputText: (paneId, text) =>
    set((state) => ({
      paneInputTexts: { ...state.paneInputTexts, [paneId]: text },
    })),

  setPaneScrollLocked: (paneId, locked) =>
    set((state) => ({
      paneScrollLocked: { ...state.paneScrollLocked, [paneId]: locked },
    })),

  setPaneHistoryIdx: (paneId, idx) =>
    set((state) => ({
      paneHistoryIdx: { ...state.paneHistoryIdx, [paneId]: idx },
    })),

  setPaneHistorySaved: (paneId, text) =>
    set((state) => ({
      paneHistorySaved: { ...state.paneHistorySaved, [paneId]: text },
    })),

  setPaneHistoryPrefix: (paneId, prefix) =>
    set((state) => {
      const next = { ...state.paneHistoryPrefix };
      if (prefix) next[paneId] = prefix;
      else delete next[paneId];
      return { paneHistoryPrefix: next };
    }),

  setPanePendingCmd: (paneId, cmd) =>
    set((state) => {
      const next = { ...state.panePendingCmd };
      if (cmd) next[paneId] = cmd;
      else delete next[paneId];
      return { panePendingCmd: next };
    }),

  clearPaneOutput: (paneId) =>
    set((state) => {
      const buf = state.paneContent[paneId];
      if (!buf) return {};
      return { paneContent: { ...state.paneContent, [paneId]: { ...buf, output: '' } } };
    }),

  setFullscreenPaneID: (id) => set({ fullscreenPaneID: id }),

  // A click names its pane, so it lands immediately and closes any armed
  // follow window — a click is newer intent than the arrow key before it.
  focusPane: (id) => set({ focusedPaneID: id, followDaemonUntil: 0 }),

  armFocusFollow: () => set({ followDaemonUntil: Date.now() + FOCUS_FOLLOW_WINDOW_MS }),

  setEscCount: (count) => set({ escCount: count }),
  setEscTimer: (timer) => set({ escTimer: timer }),

  setRenameText: (text) => set({ renameText: text }),
  setRenamePaneID: (id) => set({ renamePaneID: id }),

  toggleAgentPanel: () =>
    set((state) => ({
      showAgentPanel: !state.showAgentPanel,
      showHumanoidPanel: false,
      showSharePanel: false,
    })),

  toggleHumanoidPanel: () =>
    set((state) => ({
      showAgentPanel: false,
      showHumanoidPanel: !state.showHumanoidPanel,
      showSharePanel: false,
    })),

  toggleSharePanel: () =>
    set((state) => ({
      showAgentPanel: false,
      showHumanoidPanel: false,
      showSharePanel: !state.showSharePanel,
    })),

  setAgentList: (agents) => set({ agentList: agents }),
  setHumanoidList: (humanoids) => set({ humanoidList: humanoids }),

  setControlEnabled: (enabled) => set({ controlEnabled: enabled }),
  toggleDashboard: () => set((state) => ({ showDashboard: !state.showDashboard })),
  setDashboardTab: (tab) => set({ dashboardTab: tab }),

  setPairingState: (humanoid, state) =>
    set((s) => ({ pairings: { ...s.pairings, [humanoid]: state } })),

  addPendingPairing: (req) =>
    set((s) => {
      const existing = s.pairings[req.humanoid_name] || { pending: [], allowlist: [] };
      // Upsert by code so a re-announced request doesn't duplicate.
      const pending = [
        ...existing.pending.filter((p) => p.code !== req.code),
        {
          code: req.code,
          sender_id: req.sender_id,
          sender_name: req.sender_name,
          channel: req.channel,
          first_msg: req.first_msg,
          created_at: req.created_at ?? Math.floor(Date.now() / 1000),
          expires_at: req.expires_at,
        },
      ];
      return {
        pairings: { ...s.pairings, [req.humanoid_name]: { ...existing, pending } },
      };
    }),

  setPairingQR: (qr) =>
    set((s) => ({
      pairingQRs: { ...s.pairingQRs, [`${qr.humanoid_name}:${qr.channel}`]: qr },
    })),

  setPairingStatus: (status) =>
    set((s) => ({
      pairingStatuses: {
        ...s.pairingStatuses,
        [`${status.humanoid_name}:${status.channel}`]: status,
      },
    })),
  setShareList: (shares) => set({ shareList: shares }),

  appendPipelineOutput: (tabId, text) =>
    set((state) => ({
      pipelineOutputs: {
        ...state.pipelineOutputs,
        [tabId]: (state.pipelineOutputs[tabId] || '') + text,
      },
    })),

  addBrowserTurn: (paneId, turn) =>
    set((state) => ({
      browserTurns: {
        ...state.browserTurns,
        [paneId]: [...(state.browserTurns[paneId] || []), turn],
      },
    })),

  addBrowserPrompt: (paneId, prompt) =>
    set((state) => {
      const p = prompt.trim();
      if (!p) return {};
      // Anchor the AI reply at the current absolute chat-turn index, exactly
      // like the in-panel chat box does before sending. Turn indices are stable
      // (capping bumps `base` instead of shifting), unlike char offsets.
      const ct = state.chatTurns[paneId];
      const aiStartTurn = ct ? ct.base + ct.entries.length : 0;
      const list = state.browserTurns[paneId] || [];
      const turn = { id: `t-cmd-${Date.now()}-${list.length}`, prompt: p, ts: Date.now(), aiStartTurn };
      return {
        browserTurns: { ...state.browserTurns, [paneId]: [...list, turn] },
        // Surface the panel so the user sees the prompt + reply land.
        webChatOpen: { ...state.webChatOpen, [paneId]: true },
      };
    }),

  appendChatTurn: (paneId, turnId, text) =>
    set((state) => {
      if (!text) return {};
      const cur = state.chatTurns[paneId] || { base: 0, entries: [] };
      const entries = [...cur.entries];
      // A tagged chunk appends to its own run's entry (found from the end, so a
      // straggler flushed after a newer run started still lands in its turn);
      // an untagged chunk ('' — legacy MsgPane*OutputAppend) continues the most
      // recent entry. Anything else starts a new turn.
      let idx = -1;
      if (turnId === '') {
        idx = entries.length - 1;
      } else {
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].turnId === turnId) { idx = i; break; }
        }
      }
      if (idx >= 0) {
        // capTail bounds a single runaway answer; trimming within ONE entry only
        // affects that bubble's own head, never other turns' boundaries.
        entries[idx] = { ...entries[idx], content: capTail(entries[idx].content + text) };
      } else {
        entries.push({ turnId, content: capTail(text) });
      }
      // Cap by dropping whole oldest turns; base keeps absolute indices stable.
      let base = cur.base;
      while (entries.length > MAX_CHAT_TURNS) {
        entries.shift();
        base++;
      }
      return { chatTurns: { ...state.chatTurns, [paneId]: { base, entries } } };
    }),

  setWebChatOpen: (paneId, open) =>
    set((state) => ({ webChatOpen: { ...state.webChatOpen, [paneId]: open } })),

  setEmailList: (humanoid, emails) =>
    set((state) => ({
      emailList: { ...state.emailList, [humanoid]: emails },
      emailLoading: { ...state.emailLoading, [humanoid]: false },
      emailError: { ...state.emailError, [humanoid]: '' },
    })),

  setEmailDetail: (humanoid, email) =>
    set((state) => ({
      emailDetails: {
        ...state.emailDetails,
        [humanoid]: { ...(state.emailDetails[humanoid] || {}), [email.uid]: email },
      },
    })),

  setEmailLoading: (humanoid, loading) =>
    set((state) => ({ emailLoading: { ...state.emailLoading, [humanoid]: loading } })),

  setEmailError: (humanoid, err) =>
    set((state) => ({
      emailError: { ...state.emailError, [humanoid]: err },
      emailLoading: { ...state.emailLoading, [humanoid]: false },
    })),

  setEmailSelectedUID: (paneId, uid) =>
    set((state) => ({ emailSelectedUID: { ...state.emailSelectedUID, [paneId]: uid } })),

  setEmailChatOpen: (paneId, open) =>
    set((state) => ({ emailChatOpen: { ...state.emailChatOpen, [paneId]: open } })),

  setWhatsAppList: (humanoid, messages) =>
    set((state) => ({
      whatsappList: { ...state.whatsappList, [humanoid]: messages },
      whatsappLoading: { ...state.whatsappLoading, [humanoid]: false },
      whatsappError: { ...state.whatsappError, [humanoid]: '' },
    })),
  setWhatsAppDetail: (humanoid, message) =>
    set((state) => ({
      whatsappDetails: {
        ...state.whatsappDetails,
        [humanoid]: { ...(state.whatsappDetails[humanoid] || {}), [message.id]: message },
      },
    })),
  setWhatsAppLoading: (humanoid, loading) =>
    set((state) => ({ whatsappLoading: { ...state.whatsappLoading, [humanoid]: loading } })),
  setWhatsAppError: (humanoid, err) =>
    set((state) => ({
      whatsappError: { ...state.whatsappError, [humanoid]: err },
      whatsappLoading: { ...state.whatsappLoading, [humanoid]: false },
    })),
  setWhatsAppSelectedID: (paneId, id) =>
    set((state) => ({ whatsappSelectedID: { ...state.whatsappSelectedID, [paneId]: id } })),
  setWhatsAppChatOpen: (paneId, open) =>
    set((state) => ({ whatsappChatOpen: { ...state.whatsappChatOpen, [paneId]: open } })),

  predictEcho: (paneId, ch) =>
    set((state) => {
      if (!PREDICTIVE_ECHO_ENABLED) return {}; // local echo disabled — render only the authoritative stream
      const existing = state.paneEcho[paneId];
      if (existing) {
        return {
          paneEcho: {
            ...state.paneEcho,
            [paneId]: { ...existing, text: existing.text + ch, ts: Date.now() },
          },
        };
      }
      const pane = findPane(state.snapshot, paneId);
      if (!pane) return {};
      const c = paneCursor(pane);
      return {
        paneEcho: {
          ...state.paneEcho,
          [paneId]: { text: ch, row: c.row, col: c.col, ts: Date.now() },
        },
      };
    }),

  backspaceEcho: (paneId) =>
    set((state) => {
      if (!PREDICTIVE_ECHO_ENABLED) return {}; // local echo disabled — render only the authoritative stream
      const e = state.paneEcho[paneId];
      if (!e) return {};
      const text = e.text.slice(0, -1);
      if (!text) {
        const rest = { ...state.paneEcho };
        delete rest[paneId];
        return { paneEcho: rest };
      }
      return { paneEcho: { ...state.paneEcho, [paneId]: { ...e, text, ts: Date.now() } } };
    }),

  clearEcho: (paneId) =>
    set((state) => {
      if (!state.paneEcho[paneId]) return {};
      const rest = { ...state.paneEcho };
      delete rest[paneId];
      return { paneEcho: rest };
    }),

  // Seeding, batch by batch. Mirrors seedContent()'s per-pane assignment
  // exactly — wholesale replacement, not an append — because these carry the
  // pane's CURRENT buffers, not a delta. Reusing appendPaneOutput here would be
  // wrong: its 'ai' mode writes to both output and aiOutput, so replaying a
  // snapshot through it would duplicate the AI text inside output.
  applyPaneContentSeed: (panes) =>
    set((state) => {
      const content = { ...state.paneContent };
      const vt = { ...state.paneVT };
      const history = { ...state.paneHistory };
      for (const p of panes) {
        if (!p?.pane_id) continue;
        if (p.shell_history || p.prompt_history) {
          history[p.pane_id] = { shell: p.shell_history || [], prompt: p.prompt_history || [] };
        }
        content[p.pane_id] = {
          output: p.output || '',
          aiOutput: p.ai_output || '',
          ryshOutput: p.rysh_output || '',
          chatOutput: p.chat_output || '',
          externalOutput: p.external_output || '',
          modeOutputs: { ...(p.mode_outputs || {}) },
        };
        vt[p.pane_id] = {
          raw_mode: p.raw_mode,
          vt_screen: p.vt_screen,
          vt_cursor_row: p.vt_cursor_row,
          vt_cursor_col: p.vt_cursor_col,
          remote_interactive: p.remote_interactive,
          remote_vt_screen: p.remote_vt_screen,
          remote_vt_cursor_row: p.remote_vt_cursor_row,
          remote_vt_cursor_col: p.remote_vt_cursor_col,
        };
      }
      return { paneContent: content, paneVT: vt, paneHistory: history };
    }),

  appendPaneOutput: (paneId, mode, text) =>
    set((state) => {
      const buf = state.paneContent[paneId] || { output: '', aiOutput: '', ryshOutput: '', chatOutput: '', externalOutput: '' };
      const next = { ...buf };
      switch (mode) {
        case 'shell': next.output = capTail(buf.output + text); break;
        case 'ai': next.output = capTail(buf.output + text); next.aiOutput = capTail(buf.aiOutput + text); break;
        case 'chat': next.chatOutput = capTail(buf.chatOutput + text); break;
        case 'rysh': next.ryshOutput = capTail(buf.ryshOutput + text); break;
        case 'email': case 'slack': case 'chatbot': next.externalOutput = capTail(buf.externalOutput + text); break;
        default: {
          // Dynamic per-humanoid mode (e.g. "slack-bot"): accumulate into its own
          // keyed buffer so the pane's humanoid-mode view streams live.
          const mo = { ...(buf.modeOutputs || {}) };
          mo[mode] = capTail((mo[mode] || '') + text);
          next.modeOutputs = mo;
          break;
        }
      }
      return { paneContent: { ...state.paneContent, [paneId]: next } };
    }),

  setPaneVT: (paneId, vt) =>
    set((state) => ({ paneVT: { ...state.paneVT, [paneId]: vt } })),

  setWebPaneStatus: (status) =>
    set((state) => ({
      webPaneStatuses: {
        ...state.webPaneStatuses,
        [status.paneId]: status,
      },
    })),

  setWebEnv: (env) => set({ webEnv: env }),

  // Whole-value replace, deliberately: a board_result is a complete answer for
  // that pane, and an error result must be able to REPLACE a previous good one.
  // Merging the two would leave last good threads sitting under a "recorder is
  // not answering" banner, which reads as live data that is anything but.
  setBoardData: (data) =>
    set((state) => ({ boardData: { ...state.boardData, [data.paneId]: data } })),

  setWebPaneFrame: (frame) =>
    set((state) => {
      // A fresh frame supersedes any earlier error for the pane.
      const next: Partial<AppStore> = {
        webPaneFrames: { ...state.webPaneFrames, [frame.paneId]: frame },
      };
      if (state.webPaneErrors[frame.paneId]) {
        const rest = { ...state.webPaneErrors };
        delete rest[frame.paneId];
        next.webPaneErrors = rest;
      }
      return next;
    }),

  setWebPaneError: (paneId, error) =>
    set((state) => ({
      webPaneErrors: { ...state.webPaneErrors, [paneId]: error },
    })),

  setWebBinding: (paneId, profile, url) =>
    set((state) => ({
      webBindings: { ...state.webBindings, [paneId]: { profile, url } },
    })),

  clearWebBinding: (paneId) =>
    set((state) => {
      if (!state.webBindings[paneId]) return {};
      const rest = { ...state.webBindings };
      delete rest[paneId];
      return { webBindings: rest };
    }),

  setVoiceConfig: (c) => set({ voiceConfig: c }),
  setVoiceState: (s) => set({ voiceState: s }),
  setVoiceError: (e) => set({ voiceError: e }),

  setSidecarPort: (port) => set({ sidecarPort: port }),
  bumpWsEpoch: () => set((s) => ({ wsEpoch: s.wsEpoch + 1 })),

  setWorkspace: (path, name) => set({ workspacePath: path, workspaceName: name }),

  getEffectiveActivePaneID: () => {
    const { focusedPaneID, snapshot } = get();
    if (focusedPaneID) return focusedPaneID;
    return snapshot?.active_pane_id || '';
  },
}));
