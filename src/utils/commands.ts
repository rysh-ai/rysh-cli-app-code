import { useStore } from '../store';

/**
 * Send a command to the Go server via WebSocket.
 */
// Commands whose landing pane only the daemon can work out. "Left" and "next
// in the stack" depend on a layout this window does not model, and creating a
// pane invents an id the daemon alone knows — so these ask the daemon where
// focus went and adopt its answer (store.armFocusFollow + resolveFocus).
//
// Membership is the whole focus policy: an action listed here lets the daemon
// move this window's cursor once, and everything NOT listed here — an agent
// spawning a pane, a background job finishing, another client clicking — is
// ignored. That is what keeps you typing in pane 1 while pane 2 works.
//
// focus_pane_by_id is absent on purpose: that IS the click, and the caller has
// already named the pane locally via store.focusPane — there is nothing to wait
// for.
const FOCUS_ADOPTING_ACTIONS = new Set([
  // directional / cyclic pane navigation
  'focus_pane_left',
  'focus_pane_right',
  'focus_pane_up',
  'focus_pane_down',
  'focus_next_pane',
  'focus_prev_pane',
  // tab navigation — a new tab shows a different pane
  'focus_next_tab',
  'focus_prev_tab',
  'focus_tab_index',
  'create_tab',
  'move_tab',
  // stack rotation
  'stacked_pane_next',
  'stacked_pane_prev',
  'stacked_pane_select',
  'stacked_pane_move',
  'swap_pane',
  // structural changes the user asked for: the daemon focuses the pane it just
  // made, and focuses a survivor when one closes
  'create_pane',
  'create_pane_down',
  'create_stacked_pane',
  'close_pane',
  'switch_workspace',
]);

export function sendCommand(action: string, params?: Record<string, unknown>): void {
  const ws = useStore.getState().ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (FOCUS_ADOPTING_ACTIONS.has(action)) {
    useStore.getState().armFocusFollow();
  }
  ws.send(
    JSON.stringify({
      type: 'command',
      data: { action, params: params || {} },
    })
  );
}

// --- Control dashboard (openclaw_roadmap design 005 / R1) ---
// The terminal and the dashboard drive the SAME typed messages — these actions
// map 1:1 onto ##humanoid subcommands, so behaviour cannot diverge between the
// two surfaces. Every mutating action is rejected server-side unless the daemon
// runs with control mode enabled (RYSH_WEB_CONTROL / `##rysh web start --control`).

export function sendControlStatus(): void {
  sendCommand('control_status');
}
export function sendPairingList(humanoidName: string, channel = ''): void {
  sendCommand('pairing_list', { humanoid_name: humanoidName, channel });
}
export function sendPairingApprove(humanoidName: string, code: string, channel = ''): void {
  sendCommand('pairing_approve', { humanoid_name: humanoidName, channel, code });
}
export function sendChannelAllow(humanoidName: string, senderId: string, channel = ''): void {
  sendCommand('pairing_allow', { humanoid_name: humanoidName, channel, sender_id: senderId });
}
export function sendHumanoidGovernance(humanoidName: string, mode: 'ai' | 'human'): void {
  sendCommand('humanoid_set_governance', { humanoid_name: humanoidName, mode });
}
export function sendHumanoidReplyMode(
  humanoidName: string,
  channelType: string,
  mode: 'messages' | 'mentions'
): void {
  sendCommand('humanoid_set_reply_mode', { humanoid_name: humanoidName, channel_type: channelType, mode });
}
export function sendHumanoidChannelStart(humanoidName: string, channelType: string): void {
  sendCommand('humanoid_channel_start', { humanoid_name: humanoidName, channel_type: channelType });
}
export function sendHumanoidChannelStop(humanoidName: string, channelType: string): void {
  sendCommand('humanoid_channel_stop', { humanoid_name: humanoidName, channel_type: channelType });
}
export function sendHumanoidActivate(name: string): void {
  sendCommand('humanoid_activate', { name });
}
export function sendHumanoidDeactivate(name: string): void {
  sendCommand('humanoid_deactivate', { name });
}
