import { useStore } from '../store';

/**
 * Send a command to the Go server via WebSocket.
 */
export function sendCommand(action: string, params?: Record<string, unknown>): void {
  const ws = useStore.getState().ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
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
