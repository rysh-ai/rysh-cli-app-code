import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PaneSnapshot } from '../types';

// Wiring: the paste control is reachable on a phone. PaneBox decides "touch
// device" once at module load (IS_TOUCH_DEVICE), so the window has to look
// touch-capable BEFORE the module is imported — hence resetModules + dynamic
// import. The bytes must leave through the same raw_key_input path the soft
// keyboard uses.

// jsdom has no ResizeObserver; VTScreen sizes itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const sendCommand = vi.fn();
vi.mock('../utils/commands', async (orig) => ({
  ...(await orig<typeof import('../utils/commands')>()),
  sendCommand: (...args: unknown[]) => sendCommand(...args),
}));

const pane = {
  id: 'p1',
  raw_mode: true,
  vt_screen: ['$ '],
  vt_cursor_row: 0,
  vt_cursor_col: 2,
} as unknown as PaneSnapshot;

async function loadPaneBox(touch: boolean) {
  vi.resetModules();
  if (touch) (window as unknown as Record<string, unknown>).ontouchstart = null;
  else delete (window as unknown as Record<string, unknown>).ontouchstart;
  return (await import('./PaneBox')).PaneBox;
}

const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const realSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).ontouchstart;
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
  if (realSecure) Object.defineProperty(window, 'isSecureContext', realSecure);
  else delete (window as unknown as Record<string, unknown>).isSecureContext;
  sendCommand.mockReset();
});

describe('PaneBox — touch paste is mounted on a live interactive pane', () => {
  it('sends the pasted text to the PTY as raw_key_input', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue('héllo') },
    });
    const PaneBox = await loadPaneBox(true);
    render(<PaneBox pane={pane} isActive inputMode={'shell' as never} pipelineActive={false} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Paste into pane' }));
    });

    const raw = sendCommand.mock.calls.filter(([a]) => a === 'raw_key_input');
    expect(raw).toHaveLength(1);
    const { pane_id, data } = raw[0][1] as { pane_id: string; data: string };
    expect(pane_id).toBe('p1');
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe('héllo');
  });

  it('is not mounted on a desktop (non-touch) device', async () => {
    const PaneBox = await loadPaneBox(false);
    render(<PaneBox pane={pane} isActive inputMode={'shell' as never} pipelineActive={false} />);

    expect(screen.queryByRole('button', { name: 'Paste into pane' })).toBeNull();
  });
});
