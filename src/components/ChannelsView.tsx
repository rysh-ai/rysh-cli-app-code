import React, { useCallback } from 'react';
import { useStore } from '../store';
import {
  sendHumanoidChannelStart,
  sendHumanoidChannelStop,
  sendHumanoidReplyMode,
} from '../utils/commands';
import type { ChannelStatus } from '../types';

/**
 * DB1 — Channels view (design 005 §4.2): every humanoid's configured channels
 * with live ChannelStatus (connected / error / details) and, in control mode,
 * Start/Stop plus a reply-mode toggle. Status refreshes with each
 * humanoid_list reply, so it stays live while the dashboard is open.
 */

interface ChannelRowProps {
  humanoidName: string;
  channel: ChannelStatus;
  controlEnabled: boolean;
}

const ChannelRow = React.memo(function ChannelRow({ humanoidName, channel, controlEnabled }: ChannelRowProps) {
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
  );
});

export const ChannelsView = React.memo(function ChannelsView() {
  const humanoids = useStore((s) => s.humanoidList);
  const controlEnabled = useStore((s) => s.controlEnabled);

  if (humanoids.length === 0) {
    return <p className="text-[12px] text-[#666] italic mt-4 text-center">No humanoids registered</p>;
  }

  return (
    <div className="flex flex-col gap-3">
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
                <ChannelRow key={ch.type} humanoidName={h.name} channel={ch} controlEnabled={controlEnabled} />
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
