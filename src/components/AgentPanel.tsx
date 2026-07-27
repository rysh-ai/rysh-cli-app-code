import React, { useState } from 'react';
import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import type { AgentInfo } from '../types';

const AgentRow = React.memo(function AgentRow({ agent }: { agent: AgentInfo }) {
  const activePaneID = useStore((s) => s.getEffectiveActivePaneID());

  return (
    <div className="flex items-center justify-between px-2 py-1 border-b border-[#333] hover:bg-[#2a2a2a]">
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${agent.active ? 'bg-[#87ff87]' : 'bg-[#585858]'}`}
        />
        <span className="text-[12px] font-mono text-[#d4d4d4] truncate">{agent.name}</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {agent.registered_panes && agent.registered_panes.length > 0 && (
          <span className="text-[10px] text-[#808080]">
            {agent.registered_panes.length}p
          </span>
        )}
        <button
          onClick={() => sendCommand(agent.active ? 'agent_deactivate' : 'agent_activate', { name: agent.name })}
          className={`px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
            agent.active
              ? 'bg-[#5f0000] text-[#ff8787] hover:bg-[#870000]'
              : 'bg-[#005f00] text-[#87ff87] hover:bg-[#008700]'
          }`}
        >
          {agent.active ? 'OFF' : 'ON'}
        </button>
        <button
          onClick={() => sendCommand('agent_register_output', { agent_name: agent.name, pane_id: activePaneID })}
          className="px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer bg-[#333] text-[#808080] hover:bg-[#444] hover:text-[#bbb]"
          title="Register output to active pane"
        >
          +P
        </button>
        <button
          onClick={() => sendCommand('agent_delete', { name: agent.name })}
          className="px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer bg-[#333] text-[#808080] hover:bg-[#5f0000] hover:text-[#ff8787]"
        >
          X
        </button>
      </div>
    </div>
  );
});

export function AgentPanel() {
  const agents = useStore((s) => s.agentList);
  const [newName, setNewName] = useState('');

  return (
    <div className="absolute right-0 top-0 bottom-0 w-[280px] bg-[#1e1e1e] border-l border-[#333] z-50 flex flex-col shadow-lg">
      <div className="px-2 py-1.5 border-b border-[#555] flex items-center justify-between bg-[#222]">
        <span className="text-[12px] font-bold text-[#87ffff]">Agents ({agents.length})</span>
        <span
          onClick={() => useStore.getState().toggleAgentPanel()}
          className="text-[#808080] hover:text-[#d4d4d4] cursor-pointer text-[14px] leading-none px-1"
        >
          x
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {agents.length === 0 ? (
          <div className="p-3 text-[#555] text-[12px] text-center italic">No agents</div>
        ) : (
          agents.map((a) => <AgentRow key={a.name} agent={a} />)
        )}
      </div>

      <div className="px-2 py-1.5 border-t border-[#555] flex gap-1">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="agent name..."
          className="flex-1 bg-[#1a1a1a] border border-[#444] rounded px-1.5 py-0.5 text-[12px] text-[#d4d4d4] font-mono outline-none focus:border-[#00d7d7] placeholder:text-[#555]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim()) {
              sendCommand('agent_create', { name: newName.trim() });
              setNewName('');
              setTimeout(() => sendCommand('agent_list'), 300);
            }
          }}
        />
        <button
          onClick={() => {
            if (newName.trim()) {
              sendCommand('agent_create', { name: newName.trim() });
              setNewName('');
              setTimeout(() => sendCommand('agent_list'), 300);
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
