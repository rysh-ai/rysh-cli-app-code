import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TouchKeyMenu } from './TouchKeyMenu';

// The seam under test is the one line that picks the escape sequence:
//     onKey(appCursor && k.appSeq ? k.appSeq : k.seq)
// It is reachable at the component level (appCursor is a prop, onKey is a
// callback), so these drive the real buttons rather than an extracted helper —
// no production refactor needed to make it testable.
//
// Why it matters: in DECCKM (application cursor keys) mode a terminal app —
// less, vim's insert mode, readline — expects arrows as SS3 (ESC O A). Send the
// normal-mode CSI form (ESC [ A) instead and the app either ignores it or
// prints garbage, which on a phone is the only way to move the cursor at all.

const SS3 = '\x1bO';
const CSI = '\x1b[';

function openMenu(appCursor?: boolean) {
  const onKey = vi.fn();
  render(<TouchKeyMenu onKey={onKey} appCursor={appCursor} />);
  fireEvent.click(screen.getByLabelText('special keys'));
  return onKey;
}

function tap(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('TouchKeyMenu — menu behaviour', () => {
  it('renders no key grid until the ⌨ button is tapped', () => {
    render(<TouchKeyMenu onKey={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '↑' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('special keys'));
    expect(screen.getByRole('button', { name: '↑' })).toBeInTheDocument();
  });
});

describe('TouchKeyMenu — arrow encoding follows DECCKM', () => {
  const arrows: Array<[string, string]> = [
    ['↑', 'A'],
    ['↓', 'B'],
    ['←', 'D'],
    ['→', 'C'],
  ];

  it.each(arrows)('normal mode sends %s as the CSI form', (label, final) => {
    const onKey = openMenu(false);
    tap(label);
    expect(onKey).toHaveBeenCalledWith(CSI + final);
  });

  it.each(arrows)('application-cursor mode sends %s as the SS3 form', (label, final) => {
    const onKey = openMenu(true);
    tap(label);
    expect(onKey).toHaveBeenCalledWith(SS3 + final);
  });

  it('treats an absent appCursor prop as normal mode', () => {
    const onKey = openMenu(undefined);
    tap('↑');
    expect(onKey).toHaveBeenCalledWith('\x1b[A');
  });

  it('applies the same rule to Home and End', () => {
    const app = openMenu(true);
    tap('Home');
    tap('End');
    expect(app).toHaveBeenNthCalledWith(1, '\x1bOH');
    expect(app).toHaveBeenNthCalledWith(2, '\x1bOF');
  });
});

describe('TouchKeyMenu — keys with no application-mode form are unaffected', () => {
  // Only cursor keys have an appSeq; DECCKM must not rewrite anything else.
  const plain: Array<[string, string]> = [
    ['Esc', '\x1b'],
    ['Tab', '\t'],
    ['⇧Tab', '\x1b[Z'],
    ['Enter', '\r'],
    ['PgUp', '\x1b[5~'],
    ['PgDn', '\x1b[6~'],
    ['^C', '\x03'],
    ['^D', '\x04'],
    ['^Z', '\x1a'],
    ['^R', '\x12'],
  ];

  it.each(plain)('%s sends its literal sequence in normal mode', (label, seq) => {
    const onKey = openMenu(false);
    tap(label);
    expect(onKey).toHaveBeenCalledWith(seq);
  });

  it.each(plain)('%s sends the identical sequence in application mode', (label, seq) => {
    const onKey = openMenu(true);
    tap(label);
    expect(onKey).toHaveBeenCalledWith(seq);
  });
});
