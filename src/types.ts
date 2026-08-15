// TypeScript interfaces matching Go domain structs in internal/domain/messages.go

export interface WorkspaceSnapshot {
  tabs: TabSnapshot[];
  active_tab_id: string;
  active_pane_id: string;
  // Multi-workspace (rysh-cli 7c87bfe): names of every workspace in the session
  // and the 0-based index of the active one. Single-workspace sessions omit
  // these (or list a single entry).
  workspaces?: string[];
  active_workspace?: number;
  // Tab-bar orientation (rysh-cli 408a9a8): true renders the tab bar as a
  // column down the left edge of the body instead of a strip in the header.
  // Per-workspace, set by `##tab orientation` / ctrl+t v / the header's ▤
  // button, and persisted with the layout. Omitted when horizontal, so an
  // older daemon (or a fresh workspace) reads as the horizontal default.
  tab_bar_vertical?: boolean;
}

export interface TabSnapshot {
  id: string;
  title: string;
  lanes: LaneSnapshot[];
  active_pane_id: string;
  pipeline_output?: string;
  pipeline_active?: boolean;
  pipeline_enabled?: boolean;
  pipeline_name?: string;
}

export interface LaneSnapshot {
  id: string;
  flex: number;
  name?: string; // lane name; defaults to the tab's pipeline name
  pane_groups: PaneGroupSnapshot[];
  active_pane_id: string;
}

export interface PaneGroupSnapshot {
  id: string;
  row_flex?: number;
  panes: PaneSnapshot[];
  active_pane_id: string;
}

export interface ConversationMessage {
  turn_id: string;
  turn_type: string;
  conversation_type: string;
  input_type: string;
  message_source: string;
  content: string;
  timestamp_ms: number;
  sensitive?: boolean;
  subject_to_share?: boolean;
  streaming?: boolean;
}

export interface PaneSnapshot {
  id: string;
  title: string;
  flex: number;
  lane_id?: string;
  mode: string;
  // Per-pane enabled input modes (rysh-cli ##mode). Source of truth for the
  // mode cycle; empty/absent in pre-field snapshots → default set.
  enabled_modes?: string[];
  output: string;
  status: string;
  last_command: string;
  provider_name: string;
  given_name?: string;
  merged_history?: string[];
  shell_history?: string[];
  prompt_history?: string[];
  rysh_history?: string[];
  chat_history?: string[];
  shell_output?: string;
  ai_output?: string;
  rysh_output?: string;
  chat_output?: string;
  external_output?: string;
  // Per-pane output buffers for dynamic per-humanoid modes, keyed by mode name
  // (the humanoid name, e.g. "slack-bot"). Populated once a humanoid registers
  // its output to the pane (##humanoid register-output).
  mode_outputs?: Record<string, string>;
  external_history?: string[];
  pane_type?: string;
  // Free-form pane metadata the daemon has always sent and this client never
  // declared. `board.id` names which board an agents-board pane renders
  // (design 028); fleet.name / fleet.role / epic identify a fleet member.
  meta?: Record<string, string>;
  shell_pid?: number; // OS pid of the pane's shell, used to resolve cwd for tab-completion
  // Live shell cwd as reported via OSC 7 (push-based, exact after every
  // prompt). Preferred over shell_pid+lsof resolution when non-empty.
  shell_cwd?: string;
  // ##native pass-through: the pane is a plain terminal (bash owns readline/
  // completion/history/PS1); double-Esc exits to prompt mode.
  native_mode?: boolean;
  merged_conv?: ConversationMessage[];
  conversations?: Record<string, ConversationMessage[]>;
  listening_to_id?: string;
  hopped_from_alias?: string;
  hopped_from_id?: string;
  has_hopped_content?: boolean;
  sharing?: boolean;
  upstream_url?: string;
  upstream_connected?: boolean;
  controlling_share_id?: string;
  controlling_pane_alias?: string;
  connected_to_pane_id?: string;
  raw_mode?: boolean;
  vt_screen?: string[];
  vt_cursor_row?: number;
  vt_cursor_col?: number;
  remote_interactive?: boolean;
  remote_vt_screen?: string[];
  remote_vt_cursor_row?: number;
  remote_vt_cursor_col?: number;
  row_flex?: number;
  stacked_titles?: string[];
  stack_position?: number;
  stack_total?: number;
  stack_collapsed?: boolean;

  // Attention mechanism state.
  attention_enabled?: boolean;
  attention_count?: number;
  attention_category?: string;
  attention_title?: string;

  // Mouse tracking enabled by child process.
  mouse_enabled?: boolean;
  // Child enabled DECCKM (application cursor keys): send arrows as \x1bO[A-D],
  // not \x1b[[A-D] — termcap programs (less) ignore the CSI form.
  app_cursor_keys?: boolean;

  // Structured conversation histories.
  conv_histories?: Record<string, ConversationMessage[]>;
  merged_conv_history?: ConversationMessage[];

  // Registered humanoid for this pane.
  registered_humanoid?: string;

  // Web pane fields (populated when input_mode === 'web')
  web_url?: string;
  // Persistent Chromium profile name bound to this web pane (rysh-cli ##mode
  // new web --profile). Maps to a session partition + .rysh/browser-instances/.
  web_profile?: string;
  web_title?: string;
  // Increments each time `##mode new web` (re)binds this pane. The store uses it
  // as an explicit "show & rebind the browser now" signal so re-running the
  // command from another display mode switches the pane back to web.
  web_activate_seq?: number;
  web_can_go_back?: boolean;
  web_can_go_forward?: boolean;
  web_loading?: boolean;
}

// --- Agent / Humanoid / Share info types (from WebSocket list responses) ---

export interface AgentInfo {
  name: string;
  active: boolean;
  system_prompt: string;
  registered_panes?: string[];
}

export interface ChannelStatus {
  type: string;
  connected: boolean;
  error?: string;
  details?: string;
}

export interface HumanoidInfo {
  name: string;
  active: boolean;
  system_prompt: string;
  registered_panes?: string[];
  channels?: ChannelStatus[];
}

// --- Control dashboard (openclaw_roadmap design 005 / R1) ---
// Recovered from rysh-cli b1d1d1f, where these views were lost in merge
// eae16dc. Shapes mirror the Go frames pushed by internal/web/server_control.go.

/** Wire form of one pending pairing request (msg.PendingPair). */
export interface PendingPair {
  code: string;
  sender_id: string;
  sender_name: string;
  channel: string;
  first_msg?: string;
  created_at: number; // unix seconds
  expires_at: number; // unix seconds
}

/** Pending + allowlist state for one humanoid (pairing_list frame). */
export interface PairingState {
  pending: PendingPair[];
  allowlist: string[];
}

/** QR/device-link payload for a (humanoid, channel) (pairing_qr frame). */
export interface PairingQR {
  humanoid_name: string;
  channel: string;
  qr: string;
}

/** Device-link state transition for a (humanoid, channel) (pairing_status frame). */
export interface PairingStatusInfo {
  humanoid_name: string;
  channel: string;
  connected: boolean;
  detail?: string;
}

export type DashboardTab = 'channels' | 'pairings' | 'humanoids';

// --- Email client (desktop Gmail-style view over an email humanoid) ---
// Mirrors the Go msg.EmailSummary / msg.EmailDetail JSON shapes.
export interface EmailSummary {
  id: string;
  uid: number;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  message_id: string;
  in_reply_to: string;
  unread?: boolean;
}

export interface EmailAttachmentInfo {
  filename: string;
  content_type: string;
  size: number;
}

export interface EmailDetail {
  id: string;
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  message_id: string;
  in_reply_to: string;
  attachments?: EmailAttachmentInfo[];
}

// Mirrors the Go msg.WhatsAppMsgSummary / msg.WhatsAppMsgDetail JSON shapes.
export interface WhatsAppMsgSummary {
  id: string;
  message_id: string;
  from: string;
  name: string;
  snippet: string;
  time: string;
}

export interface WhatsAppMsgDetail {
  id: string;
  message_id: string;
  from: string;
  name: string;
  text: string;
  time: string;
}

export interface ShareInfo {
  share_id: string;
  entity_type: string;
  entity_id: string;
  alias: string;
  mode: string;
  connected: boolean;
  url: string;
  viewers: number;
}

export interface DiffPayload {
  file_path: string;
  unified_diff: string;
}

export interface ApprovalRequest {
  request_id: string;
  orchestrator_id: string;
  tool_call_id: string;
  type: string;
  description: string;
  diff?: DiffPayload;
  choices?: { label: string; description: string }[];
}

export interface PendingApproval {
  pane_id: string;
  request: ApprovalRequest;
}

export type AppMode =
  | 'normal'
  | 'tab'
  | 'pane'
  | 'stack'
  | 'layout'
  | 'resize'
  | 'navigate'
  | 'prefix'
  | 'altpprefix'
  | 'renamepane'
  | 'renametab'
  | 'movepane'
  | 'approval'
  | 'reject_reason'
  | 'raw';

// The six fixed input modes, plus any dynamic per-humanoid mode whose name is
// the humanoid's (e.g. "slack-bot"). The `(string & {})` keeps editor
// autocomplete for the fixed literals while still permitting dynamic names.
export type InputMode = 'shell' | 'prompt' | 'rysh' | 'chat' | 'external' | 'web' | (string & {});

// FIXED_INPUT_MODES is the canonical cycle order of the built-in modes. Dynamic
// per-humanoid modes are appended after these (mirrors the daemon's
// nextEnabledMode in rysh-cli internal/tui/model_input.go).
export const FIXED_INPUT_MODES: readonly string[] = ['shell', 'prompt', 'rysh', 'chat', 'external', 'web'];

export interface WebPaneStatus {
  paneId: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

// WebEnv is the server-reported environment for the WEB (browser) build,
// fetched from GET /api/env (web_electron_roadmap W9). It replaces
// feature-sniffing: the UI shows/hides capabilities from this, so features
// either work or are visibly absent — never silently broken.
export interface WebEnv {
  isWeb: boolean;
  platform: string;
  sessionName: string;
  control: boolean;
  workspace: { path: string; name: string };
  capabilities: {
    completion: boolean;
    workspaces: boolean;
    voice: boolean;
    webPane: boolean; // server-side embedded browser available (W12)
    restartDaemon: boolean; // always false in web mode
    nativeOpen: boolean; // always false in web mode
  };
}

// WebPaneFrame is one server-side web-pane frame (roadmap W12): the current
// url/title plus a base64 JPEG screenshot streamed over /ws.
export interface WebPaneFrame {
  paneId: string;
  url: string;
  title: string;
  screenshot: string; // base64 JPEG
  // The browser viewport the screenshot was taken at. Forwarded input must be
  // hit-tested against these, not the displayed <img> size. 0 when the server
  // could not determine a size — do not divide by them unchecked.
  sourceWidth: number;
  sourceHeight: number;
}

// ── Agents board (design 025 / 028) ──
//
// An agents-board pane is SHELL-LESS: it never starts a shell, so it has no
// output buffer and no VT screen, and `pane.output` for one holds whatever
// stale text happens to be there. Its content is fetched instead, with a
// `board_get` this client sends and a `board_result` the server answers only
// this client with (internal/web/board.go).

/** One post on the board: a thread root, or a reply under one. */
export interface BoardPost {
  /** Full pane uuid of the poster. THE identity — persona is not unique. */
  pane_id: string;
  /** Display name only; two panes in different lanes may share one. */
  persona: string;
  kind: string; // free-form: milestone, task-done, blocked, reply, or an agent's own
  text: string;
  thread_id?: string;
  ts: number; // unix millis, the POSTER's clock — arrival order, not causal order
  to_persona?: string;
  to_pane_id?: string;
}

export interface BoardThread {
  key: string;
  /** null while the thread is provisional (replies arrived before their root). */
  root: BoardPost | null;
  replies: BoardPost[] | null;
  provisional: boolean;
}

export interface BoardRosterEntry {
  pane_id: string;
  persona: string;
  ts: number;
}

export interface BoardStats {
  threads: number;
  provisional: number;
  posts: number;
  duplicates: number;
  evicted: number;
  unknown_version: number;
}

/**
 * BoardData is one board_result: either an answer or a REFUSAL, never both.
 *
 * `error` and `threads` are mutually exclusive by construction on the server,
 * and the view must keep them that way. An unanswered query rendered as an
 * empty thread list would show a clean, confident, empty board — which is
 * exactly what a quiet fleet looks like, so the operator could not tell a
 * silent fleet from a recorder that has stopped answering.
 */
export interface BoardData {
  paneId: string;
  board: string;
  threads?: BoardThread[];
  roster?: BoardRosterEntry[];
  stats?: BoardStats;
  /** Threads dropped by `since` / by `limit` — so a window can say it is one. */
  filtered?: number;
  withheld?: number;
  /** False ⇒ the roster may list panes that have since closed (F-26). */
  roster_reconciled?: boolean;
  error?: string;
  /** The recorder did not answer, as opposed to a bug in the request. */
  no_recorder?: boolean;
  /** Client clock, for "as of" — the board itself carries no fetch time. */
  fetchedAt: number;
}

// ClipboardContent is the reply to a clipboard_copy (protocol §2.8), sent to
// the ASKING client only — a pane buffer holds whatever that pane printed, so
// broadcasting one viewer's copy to every client would leak it.
export interface ClipboardContent {
  requestId: string; // echoed from the request; correlate on it
  paneId: string;
  source: string; // the buffer actually read, with the default resolved
  text: string;
  truncated: boolean; // true when text is the TAIL of a larger buffer
  err: string; // empty on success; set instead of failing silently
}

/**
 * One pane's content in a seed batch (server: internal/web/seed.go paneSeed).
 * Field names match the snapshot's pane JSON so the same assignment applies.
 */
export interface PaneSeed {
  pane_id: string;
  output?: string;
  ai_output?: string;
  rysh_output?: string;
  chat_output?: string;
  external_output?: string;
  mode_outputs?: Record<string, string>;
  shell_history?: string[];
  prompt_history?: string[];
  raw_mode?: boolean;
  vt_screen?: string[];
  vt_cursor_row?: number;
  vt_cursor_col?: number;
  remote_interactive?: boolean;
  remote_vt_screen?: string[];
  remote_vt_cursor_row?: number;
  remote_vt_cursor_col?: number;
}
