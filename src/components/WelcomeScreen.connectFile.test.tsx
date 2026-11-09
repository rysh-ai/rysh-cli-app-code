import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WelcomeScreen } from './WelcomeScreen';

// S2.3 (sprint 0.2.16): the company page can hand over a small connect file
// (rysh-connect-<slug>.ryshconnect) instead of a link. The app picks a fresh one
// up from Downloads/Desktop when it starts; the welcome screen also lets the user
// choose one, through main's file dialog (the renderer never reads the file).
let openFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openFile = vi.fn(async () => ({ success: true }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).electronAPI = {
    workspace: { getRecent: async () => [], open: async () => {}, select: async () => ({ success: true }) },
    company: {
      connect: async () => ({ success: true }),
      openFile,
      onStatus: () => () => {},
      removeStatusListener: () => {},
    },
  };
});

describe('WelcomeScreen connect file', () => {
  it('says the app picks up a downloaded .ryshconnect file', async () => {
    await act(async () => {
      render(<WelcomeScreen />);
    });
    expect(screen.getByText(/\.ryshconnect/)).toBeTruthy();
  });
  it('"Choose connect file…" asks main to open one (no path or content from the renderer)', async () => {
    await act(async () => {
      render(<WelcomeScreen />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /choose connect file/i }));
    });
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith();
  });
  it('a refused file shows main\'s sentence', async () => {
    openFile.mockResolvedValueOnce({ success: false, error: 'That file holds a key; not using it.' });
    await act(async () => {
      render(<WelcomeScreen />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /choose connect file/i }));
    });
    expect(screen.getByText('That file holds a key; not using it.')).toBeTruthy();
  });
});
