import { useStore } from '../store';

/**
 * Send a command to the Go server via WebSocket.
 */
// Focus-moving commands, by action name. Issuing any of them is a NEWER
// statement of where the user wants focus, so it supersedes a pending click
// override — see clearing rules in store.setSnapshot.
//
// focus_pane_by_id is absent on purpose: that IS the click, and PaneBox sets
// the override alongside it (and re-sends it after 2.5s).
const FOCUS_MOVING_ACTIONS = new Set([
  'focus_pane_left',
  'focus_pane_right',
  'focus_pane_up',
  'focus_pane_down',
  'focus_next_pane',
  'focus_prev_pane',
  'focus_next_tab',
  'focus_prev_tab',
  'focus_tab_index',
  'stacked_pane_next',
  'stacked_pane_prev',
  'stacked_pane_select',
  'swap_pane',
]);

export function sendCommand(action: string, params?: Record<string, unknown>): void {
  const ws = useStore.getState().ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Keyboard navigation and stack rotation move focus deliberately. Drop any
  // pending click override here rather than inferring it from the snapshot:
  // the store can no longer tell "the daemon moved focus for its own reasons"
  // (a pane being created, which must NOT cancel a click) from "the user asked
  // for a different pane" (which must).
  if (FOCUS_MOVING_ACTIONS.has(action) && useStore.getState().activePaneOverride) {
    useStore.getState().setActivePaneOverride(null);
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
