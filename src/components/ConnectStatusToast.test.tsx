import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ConnectStatusToast } from './ConnectStatusToast';

// CD3 rehearsal note N2 (2026-11-05): with a workspace open, a refused company
// connect (an invalid code, a downgraded server) showed nothing — only the
// welcome screen listened for 'company-connect-status'. The toast shows the
// outcome over an open workspace: an error stays until dismissed, success fades.
type Status = { stage: 'claiming' | 'opening' | 'done' | 'error'; message: string };
let emit: ((s: Status) => void) | null = null;
let unsubscribed = 0;

beforeEach(() => {
  emit = null;
  unsubscribed = 0;
  vi.useFakeTimers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).electronAPI = {
    company: {
      onStatus: (cb: (s: Status) => void) => {
        emit = cb;
        return () => {
          unsubscribed++;
        };
      },
      removeStatusListener: () => {},
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectStatusToast', () => {
  it('shows nothing until a status arrives', () => {
    const { container } = render(<ConnectStatusToast />);
    expect(container.textContent).toBe('');
  });

  it('an error stays on screen (no timeout) until dismissed', () => {
    render(<ConnectStatusToast />);
    act(() => emit?.({ stage: 'error', message: 'connect code is invalid, expired or already used' }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('alert').textContent).toContain('invalid, expired or already used');
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('success shows, then fades after a few seconds', () => {
    render(<ConnectStatusToast />);
    act(() => emit?.({ stage: 'done', message: 'Acme is open' }));
    expect(screen.getByRole('status').textContent).toContain('Acme is open');
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('progress lines (claiming, opening) show as status, replaced by the outcome', () => {
    render(<ConnectStatusToast />);
    act(() => emit?.({ stage: 'claiming', message: 'Connecting to https://rysh.ai…' }));
    expect(screen.getByRole('status').textContent).toContain('Connecting');
    act(() => emit?.({ stage: 'error', message: 'Cancelled: not connecting to example.com.' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Cancelled');
  });

  it('unsubscribes only its own listener on unmount (never removeAllListeners)', () => {
    const { unmount } = render(<ConnectStatusToast />);
    unmount();
    expect(unsubscribed).toBe(1);
  });
});

describe('wiring (static)', () => {
  const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const welcome = readFileSync(resolve(__dirname, 'WelcomeScreen.tsx'), 'utf8');
  const preload = readFileSync(resolve(__dirname, '../../electron/preload.ts'), 'utf8');
  it('App mounts the toast in the open-workspace view', () => {
    const ws = app.slice(app.indexOf('<div id="app"'));
    expect(ws).toContain('<ConnectStatusToast />');
  });
  it('preload onStatus returns an unsubscribe that removes only that listener', () => {
    expect(preload).toMatch(/ipcRenderer\.removeListener\('company-connect-status', handler\)/);
  });
  it('the welcome screen unsubscribes its own listener instead of removing all', () => {
    expect(welcome).not.toMatch(/removeStatusListener\(\)/);
  });
});
