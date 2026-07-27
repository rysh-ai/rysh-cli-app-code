import React, { useState } from 'react';
import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import type { HumanoidInfo, ChannelStatus } from '../types';

const ChannelBadge = React.memo(function ChannelBadge({ ch }: { ch: ChannelStatus }) {
  const icon: Record<string, string> = {
    slack: '\ud83d\udcac',
    email: '\ud83d\udce7',
    chatbot: '\ud83e\udd16',
    whatsapp: '\ud83d\udcf1',
    phone: '\ud83d\udcde',
  };
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1 py-px rounded text-[10px] font-mono ${
        ch.connected
          ? 'bg-[#005f00] text-[#87ff87]'
          : ch.error
            ? 'bg-[#5f0000] text-[#ff8787]'
            : 'bg-[#333] text-[#808080]'
      }`}
      title={ch.error || ch.details || ch.type}
    >
      {icon[ch.type] || '\u2022'} {ch.type}
    </span>
  );
});

const HumanoidRow = React.memo(function HumanoidRow({
  humanoid,
}: {
  humanoid: HumanoidInfo;
}) {
  const activePaneID = useStore((s) => s.getEffectiveActivePaneID());

  return (
    <div className="px-2 py-1.5 border-b border-[#333] hover:bg-[#2a2a2a]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${humanoid.active ? 'bg-[#87ff87]' : 'bg-[#585858]'}`}
          />
          <span className="text-[12px] font-mono text-[#d4d4d4] truncate">{humanoid.name}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {humanoid.registered_panes && humanoid.registered_panes.length > 0 && (
            <span className="text-[10px] text-[#808080]">
              {humanoid.registered_panes.length}p
            </span>
          )}
          <button
            onClick={() =>
              sendCommand(humanoid.active ? 'humanoid_deactivate' : 'humanoid_activate', {
                name: humanoid.name,
              })
            }
            className={`px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
              humanoid.active
                ? 'bg-[#5f0000] text-[#ff8787] hover:bg-[#870000]'
                : 'bg-[#005f00] text-[#87ff87] hover:bg-[#008700]'
            }`}
          >
            {humanoid.active ? 'OFF' : 'ON'}
          </button>
          <button
            onClick={() =>
              sendCommand('humanoid_prompt', {
                humanoid_name: humanoid.name,
                source_pane_id: activePaneID,
              })
            }
            className="px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer bg-[#333] text-[#808080] hover:bg-[#444] hover:text-[#bbb]"
            title="Register output to active pane"
          >
            +P
          </button>
          <button
            onClick={() => sendCommand('humanoid_delete', { name: humanoid.name })}
            className="px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer bg-[#333] text-[#808080] hover:bg-[#5f0000] hover:text-[#ff8787]"
          >
            X
          </button>
        </div>
      </div>

      {/* Channel badges */}
      {humanoid.channels && humanoid.channels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1 pl-4">
          {humanoid.channels.map((ch) => (
            <span
              key={ch.type}
              onClick={() =>
                sendCommand(ch.connected ? 'humanoid_channel_stop' : 'humanoid_channel_start', {
                  humanoid_name: humanoid.name,
                  channel_type: ch.type,
                })
              }
              className="cursor-pointer"
            >
              <ChannelBadge ch={ch} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
});

export function HumanoidPanel() {
  const humanoids = useStore((s) => s.humanoidList);
  const [newName, setNewName] = useState('');

  return (
    <div className="absolute right-0 top-0 bottom-0 w-[300px] bg-[#1e1e1e] border-l border-[#333] z-50 flex flex-col shadow-lg">
      <div className="px-2 py-1.5 border-b border-[#555] flex items-center justify-between bg-[#222]">
        <span className="text-[12px] font-bold text-[#87ffff]">Humanoids ({humanoids.length})</span>
        <span
          onClick={() => useStore.getState().toggleHumanoidPanel()}
          className="text-[#808080] hover:text-[#d4d4d4] cursor-pointer text-[14px] leading-none px-1"
        >
          x
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {humanoids.length === 0 ? (
          <div className="p-3 text-[#555] text-[12px] text-center italic">No humanoids</div>
        ) : (
          humanoids.map((h) => <HumanoidRow key={h.name} humanoid={h} />)
        )}
      </div>

      <div className="px-2 py-1.5 border-t border-[#555] flex gap-1">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="humanoid name..."
          className="flex-1 bg-[#1a1a1a] border border-[#444] rounded px-1.5 py-0.5 text-[12px] text-[#d4d4d4] font-mono outline-none focus:border-[#00d7d7] placeholder:text-[#555]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim()) {
              sendCommand('humanoid_create', { name: newName.trim() });
              setNewName('');
              setTimeout(() => sendCommand('humanoid_list'), 300);
            }
          }}
        />
        <button
          onClick={() => {
            if (newName.trim()) {
              sendCommand('humanoid_create', { name: newName.trim() });
              setNewName('');
              setTimeout(() => sendCommand('humanoid_list'), 300);
            }
          }}
          className="px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer bg-[#005f5f] text-[#87ffff] hover:bg-[#008787]"
        >
          +
        </button>
      </div>
    </div>
  );
}
