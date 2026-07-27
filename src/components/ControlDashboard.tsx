import React, { useEffect } from 'react';
import { useStore } from '../store';
import { sendCommand, sendControlStatus } from '../utils/commands';
import { ChannelsView } from './ChannelsView';
import { PairingsView } from './PairingsView';
import { HumanoidsView } from './HumanoidsView';
import type { DashboardTab } from '../types';

/**
 * WS5 control dashboard shell (design 005 §4.7): a slide-over hosting the
 * Channels (DB1), Pairings (DB2), and Humanoids (DB3) tabs. Views are visible
 * in read-only mode too; mutating buttons only render when the server reports
 * control mode enabled (DB4) — and the server independently rejects mutations
 * when it isn't.
 */

const TABS: { id: DashboardTab; label: string }[] = [
  { id: 'channels', label: 'Channels' },
  { id: 'pairings', label: 'Pairings' },
  { id: 'humanoids', label: 'Humanoids' },
];

export const ControlDashboard = React.memo(function ControlDashboard() {
  const showDashboard = useStore((s) => s.showDashboard);
  const toggleDashboard = useStore((s) => s.toggleDashboard);
  const dashboardTab = useStore((s) => s.dashboardTab);
  const setDashboardTab = useStore((s) => s.setDashboardTab);
  const controlEnabled = useStore((s) => s.controlEnabled);
  const connected = useStore((s) => s.connected);

  // Refresh the roster (which carries live ChannelStatus) while open.
  useEffect(() => {
    if (!showDashboard || !connected) return;
    sendControlStatus();
    sendCommand('humanoid_list');
    const timer = setInterval(() => sendCommand('humanoid_list'), 3000);
    return () => clearInterval(timer);
  }, [showDashboard, connected]);

  if (!showDashboard) return null;

  return (
    <div
      className="fixed top-0 right-0 h-full z-[210] flex flex-col"
      style={{ width: 560, maxWidth: '100vw', backgroundColor: '#252525', borderLeft: '2px solid #00d7d7' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#333]">
        <h2 className="text-[#ffffaf] font-bold text-[15px]">rysh control</h2>
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
            controlEnabled ? 'bg-[#005f00] text-[#87ff87]' : 'bg-[#333] text-[#808080]'
          }`}
          title={
            controlEnabled
              ? 'Control mode enabled (RYSH_WEB_CONTROL) — mutations allowed, loopback bind'
              : 'Read-only — start the web server with RYSH_WEB_CONTROL=1 to enable controls'
          }
        >
          {controlEnabled ? 'control' : 'read-only'}
        </span>
        <span className="flex-1" />
        <button
          onClick={toggleDashboard}
          className="text-[#888] hover:text-[#fff] text-[18px] leading-none px-1 transition-colors"
        >
          &times;
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-[#333]">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setDashboardTab(tab.id)}
            className={`px-3 py-1 rounded text-[12px] transition-colors ${
              dashboardTab === tab.id
                ? 'bg-[#5f5f87] text-[#ffffaf] font-bold'
                : 'text-[#8a8a8a] hover:text-[#bbb] hover:bg-[#2a2a2a]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active view */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {dashboardTab === 'channels' && <ChannelsView />}
        {dashboardTab === 'pairings' && <PairingsView />}
        {dashboardTab === 'humanoids' && <HumanoidsView />}
      </div>
    </div>
  );
});
