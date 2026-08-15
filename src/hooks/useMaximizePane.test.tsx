import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { useKeyboard } from './useKeyboard';
import { PaneBox } from '../components/PaneBox';
import { useStore } from '../store';
import type { PaneSnapshot, WorkspaceSnapshot } from '../types';

// Ctrl+L m — maximize the active pane — is the TUI gesture the desktop app is
// supposed to mirror exactly (rysh-cli internal/tui/model_update.go's layout
// mode). Two things about it broke silently in the app and are pinned here:
//
//   - `m` toggled fullscreen but LEFT the app in layout mode. Nothing looked
//     wrong: the pane really did fill the window. But PaneBox forwards
//     keystrokes to an interactive program (claude, vim, less) only while
//     mode === 'normal', so a maximized claude pane went deaf, and the next
//     letter typed at it ran a layout command instead ('h' equalized widths,
//     's' swapped lanes). The TUI sets modeNormal on this key; so must we.
//
//   - the maximized pane carried `z-100`, which is not a class Tailwind v3
//     generates (its z scale stops at 50). The rule never existed, the pane
//     fell back to z-index:auto, and the header strip — `relative z-20`
//     whenever the tab bar is vertical — painted over the top 30px of the
//     "full screen" pane. The class has to be one that produces real css and
//     that outranks the header.

function snapshot(): WorkspaceSnapshot {
  return {
    tabs: [
      {
        id: 't1',
        title: 'build',
        active_pane_id: 'p1',
        lanes: [
          {
            id: 'l1',
            flex: 1,
            active_pane_id: 'p1',
            pane_groups: [
              {
                id: 'g1',
                active_pane_id: 'p1',
                panes: [
                  {
                    id: 'p1',
                    title: 'claude',
                    flex: 1,
                    mode: 'shell',
                    output: '',
                    status: '',
                    last_command: '',
                    provider_name: '',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    active_tab_id: 't1',
    active_pane_id: 'p1',
  };
}

/** Mounts the global key handler the same way App does. */
function Keys() {
  useKeyboard();
  return null;
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

afterEach(() => {
  act(() => {
    useStore.setState({ snapshot: null, ws: null, mode: 'normal', fullscreenPaneID: null });
  });
});

describe('ctrl+l m maximizes the active pane', () => {
  it('maximizes AND returns to normal mode, so keys go back to the pane', () => {
    useStore.setState({ snapshot: snapshot() });
    render(<Keys />);

    press('l', { ctrlKey: true });
    expect(useStore.getState().mode).toBe('layout');

    press('m');

    expect(useStore.getState().fullscreenPaneID).toBe('p1');
    // The load-bearing half: still in layout mode and the pane never sees a key.
    expect(useStore.getState().mode).toBe('normal');
  });

  it('restores the pane on a second ctrl+l m', () => {
    useStore.setState({ snapshot: snapshot(), fullscreenPaneID: 'p1' });
    render(<Keys />);

    press('l', { ctrlKey: true });
    press('m');

    expect(useStore.getState().fullscreenPaneID).toBeNull();
    expect(useStore.getState().mode).toBe('normal');
  });
});

// Tailwind v3's default z scale — the only `z-<n>` utilities that exist as css.
// Anything outside this set is a class name that styles nothing.
const TAILWIND_Z_SCALE = [0, 10, 20, 30, 40, 50];
// The header strip carries `relative z-20` while the tab bar is vertical
// (Header.tsx), and the right-edge drawers carry z-50 (AgentPanel /
// HumanoidPanel / SharePanel). A maximized pane belongs strictly between them.
const HEADER_Z = 20;
const SIDE_PANEL_Z = 50;

describe('a maximized pane covers the whole window', () => {
  beforeAll(() => {
    // usePaneResize observes the pane's content box; jsdom has no layout engine
    // and therefore no ResizeObserver. The stub keeps the component mountable —
    // the sizing itself is exercised in the app, not here.
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  const pane: PaneSnapshot = {
    id: 'p1',
    title: 'claude',
    flex: 1,
    mode: 'shell',
    output: '',
    status: 'running',
    last_command: '',
    provider_name: '',
  };

  it('paints above the header strip and below the side drawers', () => {
    useStore.setState({ snapshot: snapshot() });
    const { container } = render(
      <PaneBox pane={pane} isActive inputMode="shell" pipelineActive={false} isFullscreen />
    );

    const box = container.querySelector('[data-pane-id="p1"]') as HTMLElement;
    const z = box.className.match(/(?:^|\s)z-(\d+)(?:\s|$)/);
    expect(z, `no z-<n> utility on a fullscreen pane: ${box.className}`).not.toBeNull();

    const level = Number(z![1]);
    // z-100 was the original value and is NOT in the scale: it generated no
    // rule at all, so the header painted over the top of the maximized pane.
    expect(TAILWIND_Z_SCALE).toContain(level);
    expect(level).toBeGreaterThan(HEADER_Z);
    expect(level).toBeLessThan(SIDE_PANEL_Z);
  });
});
