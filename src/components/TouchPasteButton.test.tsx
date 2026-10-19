import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TouchPasteButton } from './TouchPasteButton';

// Paste on a phone (E-12(b)). The desktop path is a native `paste` event on
// `document` (PaneBox) — a phone has no Cmd+V and nothing visible to long-press
// in a live VT pane (the TouchTermInput textarea is 1px and invisible), so it
// needs a control. navigator.clipboard.readText only exists in a secure context
// (HTTPS or localhost); a phone reaching the daemon on `--bind 0.0.0.0` over
// plain http has no navigator.clipboard at all. That path must still paste —
// through a sheet the user long-presses into — and must say why.

const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const realSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

function setEnv({ secure, readText }: { secure: boolean; readText?: () => Promise<string> }) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: secure });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: readText ? { readText } : undefined,
  });
}

afterEach(() => {
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
  if (realSecure) Object.defineProperty(window, 'isSecureContext', realSecure);
  else delete (window as unknown as Record<string, unknown>).isSecureContext;
});

async function tap() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Paste into pane' }));
  });
}

describe('TouchPasteButton — secure context reads the clipboard directly', () => {
  it('pastes the clipboard text once, with no sheet', async () => {
    const readText = vi.fn().mockResolvedValue('ls -la\n');
    setEnv({ secure: true, readText });
    const onPaste = vi.fn();
    render(<TouchPasteButton onPaste={onPaste} />);

    await tap();

    expect(readText).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledWith('ls -la\n');
    expect(screen.queryByLabelText('Text to paste')).toBeNull();
  });

  it('falls back to the sheet when the browser refuses the read', async () => {
    setEnv({ secure: true, readText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) });
    const onPaste = vi.fn();
    render(<TouchPasteButton onPaste={onPaste} />);

    await tap();

    expect(onPaste).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Text to paste')).toBeInTheDocument();
    expect(screen.getByText(/would not let the page read the clipboard/)).toBeInTheDocument();
  });

  it('opens the sheet rather than sending nothing when the clipboard is empty', async () => {
    setEnv({ secure: true, readText: vi.fn().mockResolvedValue('') });
    const onPaste = vi.fn();
    render(<TouchPasteButton onPaste={onPaste} />);

    await tap();

    expect(onPaste).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Text to paste')).toBeInTheDocument();
  });
});

describe('TouchPasteButton — insecure context (plain-http LAN) still pastes, and says why', () => {
  it('does not touch the clipboard API when isSecureContext is false', async () => {
    const readText = vi.fn().mockResolvedValue('should not be read');
    setEnv({ secure: false, readText });
    render(<TouchPasteButton onPaste={vi.fn()} />);

    await tap();

    expect(readText).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Text to paste')).toBeInTheDocument();
    expect(screen.getByText(/not a secure \(HTTPS\) page/)).toBeInTheDocument();
  });

  it('opens the sheet when navigator.clipboard is undefined', async () => {
    setEnv({ secure: false });
    render(<TouchPasteButton onPaste={vi.fn()} />);

    await tap();

    expect(screen.getByLabelText('Text to paste')).toBeInTheDocument();
  });

  it('sends what was pasted into the sheet, once, and closes it', async () => {
    setEnv({ secure: false });
    const onPaste = vi.fn();
    render(<TouchPasteButton onPaste={onPaste} />);
    await tap();

    fireEvent.change(screen.getByLabelText('Text to paste'), { target: { value: 'git status' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledWith('git status');
    expect(screen.queryByLabelText('Text to paste')).toBeNull();
  });

  it('sends nothing for an empty sheet, and Cancel closes without sending', async () => {
    setEnv({ secure: false });
    const onPaste = vi.fn();
    render(<TouchPasteButton onPaste={onPaste} />);
    await tap();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onPaste).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onPaste).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Text to paste')).toBeNull();
  });

  it('gives the sheet a >=16px font so iOS does not zoom when it focuses', async () => {
    setEnv({ secure: false });
    render(<TouchPasteButton onPaste={vi.fn()} />);
    await tap();

    const ta = screen.getByLabelText('Text to paste') as HTMLTextAreaElement;
    expect(parseFloat(ta.style.fontSize)).toBeGreaterThanOrEqual(16);
  });
});
