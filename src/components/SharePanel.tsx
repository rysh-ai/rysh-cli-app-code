import React, { useState } from 'react';
import { useStore } from '../store';
import { sendCommand } from '../utils/commands';
import type { ShareInfo } from '../types';

const ShareRow = React.memo(function ShareRow({ share }: { share: ShareInfo }) {
  return (
    <div className="px-2 py-1.5 border-b border-[#333] hover:bg-[#2a2a2a]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${share.connected ? 'bg-[#87ff87]' : 'bg-[#ff8787]'}`}
          />
          <span className="text-[12px] font-mono text-[#d4d4d4] truncate">
            {share.alias || share.share_id.substring(0, 8)}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span
            className={`px-1 py-px rounded text-[10px] font-bold ${
              share.mode === 'control'
                ? 'bg-[#5f5f00] text-[#ffff87]'
                : 'bg-[#005f5f] text-[#87ffff]'
            }`}
          >
            {share.mode.toUpperCase()}
          </span>
          <span
            className={`px-1 py-px rounded text-[10px] ${
              share.entity_type === 'tab'
                ? 'bg-[#5f005f] text-[#ff87ff]'
                : share.entity_type === 'panegroup'
                  ? 'bg-[#005f5f] text-[#87ffff]'
                  : 'bg-[#333] text-[#808080]'
            }`}
          >
            {share.entity_type}
          </span>
          {share.viewers > 0 && (
            <span className="text-[10px] text-[#808080]">
              {share.viewers}v
            </span>
          )}
          <button
            onClick={() => sendCommand('unshare_entity', { entity_id: share.entity_id })}
            className="px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer bg-[#333] text-[#808080] hover:bg-[#5f0000] hover:text-[#ff8787]"
          >
            X
          </button>
        </div>
      </div>
      {share.url && (
        <div className="pl-4 mt-0.5 text-[10px] text-[#585858] truncate font-mono">{share.url}</div>
      )}
    </div>
  );
});

export function SharePanel() {
  const shares = useStore((s) => s.shareList);
  const activePaneId = useStore((s) => s.snapshot?.active_pane_id);
  const activeTabId = useStore((s) => s.snapshot?.active_tab_id);
  const [subscribeId, setSubscribeId] = useState('');

  // The daemon's share_entity command requires an entity_id; share the active
  // pane / tab. Tab shares use the mirror-tab twin (rysh-cli 63c80b1).
  function share(entityType: 'pane' | 'tab', mode: 'view' | 'control') {
    const id = entityType === 'tab' ? activeTabId : activePaneId;
    if (!id) return;
    sendCommand('share_entity', { entity_type: entityType, entity_id: id, mode });
  }

  // Subscribing to a remote (upstream) share creates a local mirror tab whose
  // interactive panes render from the live per-pane VT stream (rysh-cli
  // 98d1a02 / ef190bc / 16f9c67). There is no dedicated WS command for the
  // upstream operations, so route the `##upstream` text commands through
  // submit_input on the active pane (the daemon handles the `##` prefix and
  // prints results to the pane's rysh output).
  function runUpstream(text: string) {
    sendCommand('submit_input', { text, mode: 'rysh' });
  }
  function subscribe() {
    const id = subscribeId.trim();
    if (!id) return;
    runUpstream(`##upstream subscribe ${id}`);
    setSubscribeId('');
  }

  return (
    <div className="absolute right-0 top-0 bottom-0 w-[300px] bg-[#1e1e1e] border-l border-[#333] z-50 flex flex-col shadow-lg">
      <div className="px-2 py-1.5 border-b border-[#555] flex items-center justify-between bg-[#222]">
        <span className="text-[12px] font-bold text-[#87ffff]">Shares ({shares.length})</span>
        <span
          onClick={() => useStore.getState().toggleSharePanel()}
          className="text-[#808080] hover:text-[#d4d4d4] cursor-pointer text-[14px] leading-none px-1"
        >
          x
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {shares.length === 0 ? (
          <div className="p-3 text-[#555] text-[12px] text-center italic">No active shares</div>
        ) : (
          shares.map((s) => <ShareRow key={s.share_id} share={s} />)
        )}
      </div>

      <div className="px-2 py-1.5 border-t border-[#555] flex flex-col gap-1">
        <div className="flex gap-1">
          <button
            onClick={() => share('pane', 'view')}
            className="flex-1 px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer bg-[#005f5f] text-[#87ffff] hover:bg-[#008787]"
          >
            Share Pane (View)
          </button>
          <button
            onClick={() => share('pane', 'control')}
            className="flex-1 px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer bg-[#5f5f00] text-[#ffff87] hover:bg-[#878700]"
          >
            Share Pane (Ctrl)
          </button>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => share('tab', 'view')}
            className="flex-1 px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer bg-[#005f5f] text-[#87ffff] hover:bg-[#008787]"
          >
            Share Tab (View)
          </button>
          <button
            onClick={() => share('tab', 'control')}
            className="flex-1 px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer bg-[#5f5f00] text-[#ffff87] hover:bg-[#878700]"
          >
            Share Tab (Ctrl)
          </button>
        </div>

        {/* Subscribe to a remote (upstream) share -> opens a mirror tab. */}
        <div className="mt-1 pt-1 border-t border-[#333] flex flex-col gap-1">
          <div className="text-[10px] text-[#808080] font-bold uppercase tracking-wide">
            Subscribe to remote share
          </div>
          <div className="flex gap-1">
            <input
              type="text"
              value={subscribeId}
              placeholder="share id / alias"
              onChange={(e) => setSubscribeId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  subscribe();
                }
                e.stopPropagation();
              }}
              className="flex-1 min-w-0 bg-[#111] border border-[#333] rounded px-1.5 py-0.5 text-[11px] font-mono text-[#d4d4d4] outline-none focus:border-[#00d7d7] placeholder:text-[#555]"
            />
            <button
              onClick={subscribe}
              className="shrink-0 px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer bg-[#005f5f] text-[#87ffff] hover:bg-[#008787]"
            >
              Subscribe
            </button>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => runUpstream('##upstream shares')}
              className="flex-1 px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer bg-[#333] text-[#bbb] hover:bg-[#3a3a3a]"
              title="List shares available on the upstream server (output appears in the active pane)"
            >
              List Available
            </button>
            <button
              onClick={() => runUpstream('##upstream unsubscribe')}
              className="flex-1 px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer bg-[#333] text-[#bbb] hover:bg-[#5f0000] hover:text-[#ff8787]"
            >
              Unsubscribe
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
