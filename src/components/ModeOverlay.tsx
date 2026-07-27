import { useStore } from '../store';

export function ModeOverlay() {
  const mode = useStore((s) => s.mode);

  if (mode === 'normal' || mode === 'approval' || mode === 'reject_reason' || mode === 'renamepane' || mode === 'renametab') return null;

  const modeLabels: Record<string, string> = {
    tab: 'TAB',
    pane: 'PANE',
    stack: 'STACK',
    movepane: 'MOVE',
    layout: 'LAYOUT',
    resize: 'RESIZE',
    navigate: 'NAVIGATE',
    prefix: 'PREFIX',
    altpprefix: 'ALT+P',
    raw: 'RAW',
  };

  return (
    <div className="fixed bottom-9 left-1/2 -translate-x-1/2 z-[150] px-4 py-1.5 rounded-md font-bold text-[13px] bg-[#5f5f87] text-[#ffffaf] border border-[#8787af] shadow-lg">
      {modeLabels[mode] || mode.toUpperCase()} MODE
    </div>
  );
}
