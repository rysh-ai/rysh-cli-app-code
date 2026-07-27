import { useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useKeyboard } from './hooks/useKeyboard';
import { useElectronBridge } from './hooks/useElectronBridge';
import { useClipboard } from './hooks/useClipboard';
import { useStore } from './store';
import { Header } from './components/Header';
import { Body } from './components/Body';
import { Footer } from './components/Footer';
import { ModeOverlay } from './components/ModeOverlay';
import { ApprovalOverlay } from './components/ApprovalOverlay';
import { ConnectionStatus } from './components/ConnectionStatus';
import { AgentPanel } from './components/AgentPanel';
import { HumanoidPanel } from './components/HumanoidPanel';
import { SharePanel } from './components/SharePanel';
import { ContextMenu } from './components/ContextMenu';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ControlDashboard } from './components/ControlDashboard';

export default function App() {
  useElectronBridge();
  useWebSocket();
  useKeyboard();
  useClipboard();

  const showAgentPanel = useStore((s) => s.showAgentPanel);
  const showHumanoidPanel = useStore((s) => s.showHumanoidPanel);
  const showSharePanel = useStore((s) => s.showSharePanel);
  // Empty state: no workspace loaded (fresh instance, Close Workspace, or
  // Detach). No daemon runs here — the welcome screen is the whole UI. In a
  // plain browser (no electronAPI) there is no workspace concept; skip it.
  const workspacePath = useStore((s) => s.workspacePath);
  const showWelcome = !!window.electronAPI && !workspacePath;

  // GC native web views: a WebContentsView is kept alive only while its pane
  // still has web enabled (a profile bound). Cycling input modes preserves the
  // binding (and the live page), so cycling web→shell→…→web re-attaches the same
  // page; ##mode delete web or closing the pane drops the binding and tears it down.
  const snapshot = useStore((s) => s.snapshot);
  useEffect(() => {
    if (!window.electronAPI || !snapshot) return;
    const keep: string[] = [];
    for (const tab of snapshot.tabs || [])
      for (const lane of tab.lanes || [])
        for (const g of lane.pane_groups || [])
          for (const p of g.panes || [])
            if (p.web_profile) keep.push(p.id);
    window.electronAPI.webPane.syncAlive(keep);
  }, [snapshot]);

  if (showWelcome) {
    return <WelcomeScreen />;
  }

  return (
    <div id="app" className="flex flex-col h-screen w-screen">
      <Header />
      <div className="flex-1 flex overflow-hidden relative">
        <div className="flex-1 flex flex-col overflow-hidden">
          <Body />
        </div>
        {showAgentPanel && <AgentPanel />}
        {showHumanoidPanel && <HumanoidPanel />}
        {showSharePanel && <SharePanel />}
      </div>
      <Footer />
      <ConnectionStatus />
      <ModeOverlay />
      <ApprovalOverlay />
      <ContextMenu />
      <ControlDashboard />
    </div>
  );
}
