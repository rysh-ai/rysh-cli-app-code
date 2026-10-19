import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import MobileApp from '../MobileApp';
import { PaneInput } from './PaneInput';
import { useStore } from '../store';
import type { PaneSnapshot, WorkspaceSnapshot } from '../types';

// iOS focus-zoom on non-VT panes (design 018 §5 gap 2). iOS Safari zooms the
// page into any focused field whose font is under 16px, and the pane command
// input is 13px — so on a phone, tapping a shell/prompt pane's input zoomed
// the whole UI and left it zoomed. The mobile UI (MobileApp, chosen by
// pickMobileUI) gets a >=16px input with text assistance off, matching
// TouchTermInput; the desktop app keeps exactly its 13px input and attributes.

vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => undefined }));

beforeAll(() => {
  // MobileApp's pane screen mounts the real PaneBox, which observes its box.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const pane = {
  id: 'pane-1',
  title: 'claude',
  flex: 1,
  mode: 'shell',
  output: 'on screen',
  status: 'idle',
  last_command: '',
  provider_name: '',
  attention_count: 0,
} as unknown as PaneSnapshot;

const snapshot: WorkspaceSnapshot = {
  tabs: [
    {
      id: 't1',
      title: 'build',
      active_pane_id: pane.id,
      lanes: [{ id: 'l1', flex: 1, active_pane_id: pane.id, pane_groups: [{ id: 'g1', active_pane_id: pane.id, panes: [pane] }] }],
    },
  ],
  active_tab_id: 't1',
  active_pane_id: pane.id,
} as unknown as WorkspaceSnapshot;

afterEach(() => {
  act(() => {
    useStore.setState({ snapshot: null, connected: false, ws: null, paneInputModes: {} });
  });
});

function paneInput(): HTMLInputElement {
  return document.getElementById('input-pane-1') as HTMLInputElement;
}

describe('PaneInput on the phone UI — no iOS focus-zoom', () => {
  function openPaneScreen() {
    act(() => {
      useStore.setState({
        snapshot,
        connected: true,
        ws: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket,
        paneInputModes: {},
      });
    });
    render(<MobileApp />);
    fireEvent.click(screen.getByText('build'));
    fireEvent.click(screen.getByText('claude'));
  }

  it('renders the command input at >=16px', () => {
    openPaneScreen();
    const el = paneInput();
    expect(el).not.toBeNull();
    expect(el.className).toContain('text-[16px]');
    expect(el.className).not.toContain('text-[13px]');
  });

  it('turns off the text assistance a command line must not get', () => {
    openPaneScreen();
    const el = paneInput();
    expect(el.getAttribute('autocapitalize')).toBe('none');
    expect(el.getAttribute('autocorrect')).toBe('off');
    expect(el.getAttribute('autocomplete')).toBe('off');
    expect(el.getAttribute('spellcheck')).toBe('false');
  });
});

describe('PaneInput on the desktop UI — unchanged', () => {
  it('keeps the 13px input with no added attributes', () => {
    render(<PaneInput paneId="pane-1" isActive inputMode={'shell' as never} pipelineActive={false} />);
    const el = paneInput();
    expect(el.className).toContain('text-[13px]');
    expect(el.className).not.toContain('text-[16px]');
    expect(el.hasAttribute('autocapitalize')).toBe(false);
    expect(el.hasAttribute('autocorrect')).toBe(false);
    expect(el.hasAttribute('autocomplete')).toBe(false);
    expect(el.hasAttribute('spellcheck')).toBe(false);
  });
});
