import React, { useCallback, useState } from 'react';
import { useStore } from '../store';
import {
  sendHumanoidActivate,
  sendHumanoidDeactivate,
  sendHumanoidGovernance,
} from '../utils/commands';
import type { HumanoidInfo } from '../types';

/**
 * DB3 — Humanoids view (design 005 §4.4): the roster with activate/deactivate
 * and a governance ai|human toggle (the same MsgHumanoidSetGovernance the
 * terminal ##humanoid governance command sends — humanoid-scoped, matching
 * the message). The system prompt doubles as the skill preview; a dedicated
 * skill-file read message does not exist yet, so no server file access is
 * invented here.
 */

interface HumanoidRowProps {
  humanoid: HumanoidInfo;
  controlEnabled: boolean;
}

const HumanoidRow = React.memo(function HumanoidRow({ humanoid, controlEnabled }: HumanoidRowProps) {
  const [showPrompt, setShowPrompt] = useState(false);

  const handleToggleActive = useCallback(() => {
    if (humanoid.active) {
      sendHumanoidDeactivate(humanoid.name);
    } else {
      sendHumanoidActivate(humanoid.name);
    }
  }, [humanoid.name, humanoid.active]);

  const handleGovernance = useCallback(
    (mode: 'ai' | 'human') => {
      sendHumanoidGovernance(humanoid.name, mode);
    },
    [humanoid.name]
  );

  return (
    <div className="border border-[#333] rounded bg-[#1e1e1e] p-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: humanoid.active ? '#87ff87' : '#666' }}
        />
        <span className="font-bold text-[#ffffaf] text-[13px]">{humanoid.name}</span>
        <span className="text-[10px] text-[#666]">
          {humanoid.channels?.length || 0} channel{(humanoid.channels?.length || 0) !== 1 ? 's' : ''} ·{' '}
          {humanoid.registered_panes?.length || 0} pane{(humanoid.registered_panes?.length || 0) !== 1 ? 's' : ''}
        </span>
        <span className="flex-1" />
        {controlEnabled && (
          <>
            <div className="flex items-center gap-1" title="Governance: runtime inbound handling. Full draft-and-confirm tooling additionally requires governance: human in the skill file (registered at spawn).">
              <span className="text-[10px] text-[#808080]">gov:</span>
              <button
                onClick={() => handleGovernance('ai')}
                className="px-1.5 py-0.5 rounded text-[10px] bg-[#333] text-[#aaa] hover:bg-[#005f5f] hover:text-[#87ffff] transition-colors"
              >
                ai
              </button>
              <button
                onClick={() => handleGovernance('human')}
                className="px-1.5 py-0.5 rounded text-[10px] bg-[#333] text-[#aaa] hover:bg-[#5f5f00] hover:text-[#ffffaf] transition-colors"
              >
                human
              </button>
            </div>
            <button
              onClick={handleToggleActive}
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                humanoid.active
                  ? 'bg-[#005f00] text-[#87ff87] hover:bg-[#007700]'
                  : 'bg-[#444] text-[#aaa] hover:bg-[#555]'
              }`}
            >
              {humanoid.active ? 'Deactivate' : 'Activate'}
            </button>
          </>
        )}
      </div>

      {/* Channel summary dots */}
      {humanoid.channels && humanoid.channels.length > 0 && (
        <div className="flex items-center gap-3 mt-1.5 px-1 flex-wrap">
          {humanoid.channels.map((ch) => (
            <span key={ch.type} className="flex items-center gap-1 text-[10px] text-[#aaa]">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: ch.connected ? '#87ff87' : ch.error ? '#ff5f5f' : '#666' }}
              />
              {ch.type}
            </span>
          ))}
        </div>
      )}

      {/* Skill / system-prompt preview (read-only) */}
      {humanoid.system_prompt && (
        <div className="mt-1.5">
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className="text-[10px] text-[#808080] hover:text-[#bbb] transition-colors"
          >
            {showPrompt ? '▾ hide skill preview' : '▸ show skill preview'}
          </button>
          {showPrompt && (
            <pre className="font-mono text-[11px] text-[#999] bg-[#181818] rounded p-2 mt-1 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {humanoid.system_prompt}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

export const HumanoidsView = React.memo(function HumanoidsView() {
  const humanoids = useStore((s) => s.humanoidList);
  const controlEnabled = useStore((s) => s.controlEnabled);

  if (humanoids.length === 0) {
    return <p className="text-[12px] text-[#666] italic mt-4 text-center">No humanoids registered</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {humanoids.map((h) => (
        <HumanoidRow key={h.name} humanoid={h} controlEnabled={controlEnabled} />
      ))}
      {controlEnabled && (
        <p className="text-[10px] text-[#555] px-1">
          Governance flips inbound handling at runtime; channel-specific human-governed tools are
          registered at spawn from the skill file, so full draft-and-confirm needs{' '}
          <code className="text-[#777]">governance: human</code> declared there.
        </p>
      )}
    </div>
  );
});
