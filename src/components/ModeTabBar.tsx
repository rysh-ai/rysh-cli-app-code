import type { InputMode } from '../types';

// ModeTabBar — port of rysh-mobile's ModeTabBar: four buttons that switch the
// pane between its input modes (shell / AI / rysh / chat). Like the original,
// switching is a PURE CLIENT-SIDE view selection (rysh-mobile
// PaneViewScreen.handleModeChange → setActiveMode): nothing is sent to the
// daemon until input is submitted, at which point the active mode selects the
// submit_input mode — exactly what the double-Esc cycle already does on
// desktop. Mobile naming: rysh-mobile's 'ai' is this codebase's 'prompt'.

const MODES: { key: InputMode; label: string; color: string }[] = [
  { key: 'shell', label: 'Shell', color: '#00d75f' },
  { key: 'prompt', label: 'AI', color: '#6cb6ff' },
  { key: 'rysh', label: 'Rysh', color: '#00d7d7' },
  { key: 'chat', label: 'Chat', color: '#ffff87' },
];

interface Props {
  active: InputMode;
  onChange: (mode: InputMode) => void;
  /** pane.enabled_modes when provided — modes outside it are hidden. */
  enabledModes?: string[];
}

export function ModeTabBar({ active, onChange, enabledModes }: Props) {
  const visible =
    enabledModes && enabledModes.length > 0
      ? MODES.filter((m) => enabledModes.includes(m.key))
      : MODES;
  if (visible.length < 2) return null;
  return (
    <div
      className="shrink-0 flex bg-[#222] border-b border-[#333] select-none"
      data-testid="mode-tab-bar"
    >
      {visible.map((m) => {
        const isActive = m.key === active;
        return (
          <button
            key={m.key}
            type="button"
            onClick={() => onChange(m.key)}
            className={`flex-1 py-2 text-[13px] border-b-2 ${
              isActive ? 'font-bold' : 'text-[#808080] border-transparent'
            }`}
            style={isActive ? { color: m.color, borderBottomColor: m.color } : undefined}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
