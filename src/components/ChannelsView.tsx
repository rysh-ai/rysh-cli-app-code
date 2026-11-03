import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import {
  sendHumanoidChannelStart,
  sendHumanoidChannelStop,
  sendHumanoidReplyMode,
} from '../utils/commands';
import type { ChannelStatus } from '../types';
import type { SetupBinding } from '../types/remoteSetup';
import { RemoteSetupView } from './RemoteSetupView';

/**
 * DB1 — Channels view (design 005 §4.2): every humanoid's configured channels
 * with live ChannelStatus (connected / error / details) and, in control mode,
 * Start/Stop plus a reply-mode toggle. Status refreshes with each
 * humanoid_list reply, so it stays live while the dashboard is open.
 *
 * E33 slice C: a "Set up remote access" entry (RemoteSetupView) and, under each
 * channel, the binding line `rysh setup --status --json` reports — which chat
 * drives which agent and session. Bindings are read from the CLI, never guessed.
 */

/** `null` = this rysh cannot report bindings (yet); otherwise keyed humanoid/channel. */
type BindingMap = Map<string, SetupBinding> | null;

const bindingKey = (humanoid: string, channel: string) => `${humanoid}/${channel}`;

interface ChannelRowProps {
  humanoidName: string;
  channel: ChannelStatus;
  controlEnabled: boolean;
  /** undefined = no binding reported for this channel; null = bindings unavailable. */
  binding: SetupBinding | null | undefined;
  /** False outside the desktop app (web UI), where the CLI cannot be asked. */
  showBinding: boolean;
}

const ChannelRow = React.memo(function ChannelRow({ humanoidName, channel, controlEnabled, binding, showBinding }: ChannelRowProps) {
  const handleToggle = useCallback(() => {
    if (channel.connected) {
      sendHumanoidChannelStop(humanoidName, channel.type);
    } else {
      sendHumanoidChannelStart(humanoidName, channel.type);
    }
  }, [channel.connected, channel.type, humanoidName]);

  const handleReplyMode = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      sendHumanoidReplyMode(humanoidName, channel.type, e.target.value as 'messages' | 'mentions');
    },
    [humanoidName, channel.type]
  );

  return (
    <div className="flex flex-col">
    <div className="flex items-center gap-2 py-1 px-2 rounded hover:bg-[#242424] text-[12px]">
      <span
        className="inline-block w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: channel.connected ? '#87ff87' : channel.error ? '#ff5f5f' : '#666' }}
        title={channel.connected ? 'connected' : channel.error ? 'error' : 'not connected'}
      />
      <span className="text-[#d4d4d4] w-20 shrink-0">{channel.type}</span>
      <span className="text-[#808080] flex-1 truncate" title={channel.details || ''}>
        {channel.connected ? channel.details || 'connected' : 'not connected'}
      </span>
      {channel.error && (
        <span className="text-[#ff5f5f] text-[11px] truncate max-w-[220px]" title={channel.error}>
          {channel.error}
        </span>
      )}
      {controlEnabled && (
        <>
          <select
            defaultValue="messages"
            onChange={handleReplyMode}
            title="Reply mode: reply to all messages or only @mentions"
            className="bg-[#1a1a1a] border border-[#444] rounded text-[#aaa] text-[10px] px-1 py-0.5 outline-none"
          >
            <option value="messages">messages</option>
            <option value="mentions">mentions</option>
          </select>
          <button
            onClick={handleToggle}
            className={`px-2 py-0.5 rounded text-[11px] transition-colors shrink-0 ${
              channel.connected
                ? 'bg-[#5f0000] text-[#ff5f5f] hover:bg-[#870000]'
                : 'bg-[#005f5f] text-[#87ffff] hover:bg-[#008080]'
            }`}
          >
            {channel.connected ? 'Stop' : 'Start'}
          </button>
        </>
      )}
    </div>
    {showBinding && <p className={`pl-6 pr-2 text-[10px] font-mono truncate ${binding ? 'text-[#87afaf]' : 'text-[#666] italic'}`} title={binding?.line}>
      {binding === null
        ? 'binding: not reported by this rysh yet'
        : binding
          ? binding.line
          : 'binding: not set up yet — use Set up remote access'}
    </p>}
    </div>
  );
});

export const ChannelsView = React.memo(function ChannelsView() {
  const humanoids = useStore((s) => s.humanoidList);
  const controlEnabled = useStore((s) => s.controlEnabled);
  const [setupOpen, setSetupOpen] = useState(false);
  const [bindings, setBindings] = useState<BindingMap>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const api = window.electronAPI?.remoteSetup;
    if (!api) return;
    let alive = true;
    api.bindings().then(
      (r) => {
        if (!alive) return;
        setBindings(r.ok ? new Map(r.bindings.map((b) => [bindingKey(b.humanoid, b.channel), b])) : null);
      },
      () => { if (alive) setBindings(null); }
    );
    return () => { alive = false; };
  }, [refresh]);

  const header = (
    <div className="flex items-center gap-2">
      <span className="flex-1" />
      {!setupOpen && (
        <button
          onClick={() => setSetupOpen(true)}
          className="px-2 py-0.5 rounded text-[11px] bg-[#5f5f87] text-[#ffffaf] hover:bg-[#767699] transition-colors"
        >
          Set up remote access
        </button>
      )}
    </div>
  );
  const setup = setupOpen && (
    <RemoteSetupView onClose={() => setSetupOpen(false)} onDone={() => setRefresh((n) => n + 1)} />
  );

  if (humanoids.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        {setup}
        <p className="text-[12px] text-[#666] italic mt-4 text-center">No humanoids registered</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {header}
      {setup}
      {humanoids.map((h) => (
        <div key={h.name} className="border border-[#333] rounded bg-[#1e1e1e] p-2">
          <div className="flex items-center gap-2 mb-1 px-1">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: h.active ? '#87ff87' : '#666' }}
            />
            <span className="font-bold text-[#ffffaf] text-[13px]">{h.name}</span>
            <span className="text-[10px] text-[#666]">{h.active ? 'active' : 'inactive'}</span>
          </div>
          {h.channels && h.channels.length > 0 ? (
            <div className="flex flex-col">
              {h.channels.map((ch) => (
                <ChannelRow
                  key={ch.type}
                  humanoidName={h.name}
                  channel={ch}
                  controlEnabled={controlEnabled}
                  binding={bindings === null ? null : bindings.get(bindingKey(h.name, ch.type))}
                  showBinding={!!window.electronAPI?.remoteSetup}
                />
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-[#666] italic px-2 py-1">No channels configured</p>
          )}
        </div>
      ))}
    </div>
  );
});
