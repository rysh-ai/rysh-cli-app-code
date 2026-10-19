import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { TouchTermInput } from './TouchTermInput';

// TouchTermInput is the reason a phone can type into a live VT pane at all: the
// web renderer draws the terminal itself and listens on `document`, so without a
// real focusable element a tap has nothing to focus and the soft keyboard never
// appears. It is a port of rysh-mobile's InteractiveTerminal mechanism (the
// component header says so), and every rule below is load-bearing on a device
// while being invisible in a code review:
//
//   - the element must stay FOCUSABLE while invisible. display:none and
//     visibility:hidden cannot be focused, and iOS refuses the keyboard for a
//     zero-width input — which is why it is opacity:0 at 1px rather than hidden,
//     and why font-size must stay >= 16px (iOS zooms the page otherwise).
//   - a key that keyToBytes claims must be preventDefault'ed AND
//     stopPropagation'ed, or the document-level desktop handler sends it a
//     second time; a key it declines must be left alone so the multiplexer
//     chords still reach that handler.
//   - IME keydowns (Android Gboard reports keyCode 229 / key 'Unidentified')
//     carry no usable key and must be dropped, or the pane receives garbage
//     alongside the composed text.
//   - text is UTF-8 bytes on the wire, not char codes.
//
// The `inputType` switch (insertText / insertLineBreak / deleteContentBackward)
// is reached through a NATIVE beforeinput listener. It used to be wired as
// React's onBeforeInput, which react-dom synthesizes from
// ['compositionend','keypress','textInput','paste'] — none of which carries
// `inputType` — so the switch never matched and Android backspace sent nothing
// and Enter sent LF (F-75). The tests at the bottom dispatch real InputEvents.

/** onBytes spy + a keyToBytes that accepts everything unless told otherwise. */
function setup(keyToBytes: (e: KeyboardEvent) => number[] | null = () => [65]) {
  const onBytes = vi.fn();
  const spy = vi.fn(keyToBytes);
  render(<TouchTermInput onBytes={onBytes} keyToBytes={spy} />);
  const el = screen.getByLabelText('terminal input') as HTMLTextAreaElement;
  return { onBytes, keyToBytes: spy, el };
}

describe('TouchTermInput — hidden but focusable, or the phone keyboard never opens', () => {
  it('renders a textarea the tap handler can focus', () => {
    const { el } = setup();
    expect(el.tagName).toBe('TEXTAREA');

    el.focus();
    expect(document.activeElement).toBe(el);
  });

  it('hides it with opacity rather than any property that would kill focus', () => {
    const { el } = setup();
    expect(el.style.opacity).toBe('0');
    // The two ways of hiding that make an element unfocusable.
    expect(el.style.display).not.toBe('none');
    expect(el.style.visibility).not.toBe('hidden');
  });

  it('keeps a non-zero size and a >=16px font so iOS raises the keyboard without zooming', () => {
    const { el } = setup();
    expect(el.style.width).toBe('1px');
    expect(el.style.height).toBe('1px');
    expect(parseFloat(el.style.fontSize)).toBeGreaterThanOrEqual(16);
  });

  it('turns off every text assistance a terminal must not get', () => {
    const { el } = setup();
    expect(el.getAttribute('autocapitalize')).toBe('none');
    expect(el.getAttribute('autocorrect')).toBe('off');
    expect(el.getAttribute('autocomplete')).toBe('off');
    expect(el.getAttribute('spellcheck')).toBe('false');
  });
});

describe('TouchTermInput — keydown forwards through the shared key mapping', () => {
  it('sends exactly the bytes keyToBytes returned', () => {
    const { onBytes, el } = setup(() => [27, 91, 65]);
    fireEvent.keyDown(el, { key: 'ArrowUp' });

    expect(onBytes).toHaveBeenCalledTimes(1);
    expect(onBytes.mock.calls[0][0]).toEqual([27, 91, 65]);
  });

  it('consumes a key it handled, so the document handler cannot send it twice', () => {
    const { el } = setup(() => [65]);
    const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    const stop = vi.spyOn(ev, 'stopPropagation');

    fireEvent(el, ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalled();
  });

  it('leaves a key it declined alone, so multiplexer chords still reach the global handler', () => {
    const { onBytes, el } = setup(() => null);
    const ev = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
    const stop = vi.spyOn(ev, 'stopPropagation');

    fireEvent(el, ev);

    expect(onBytes).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  // The echo tells the caller how to update the local screen before the PTY
  // answers, so a printable character must be distinguishable from a deletion
  // and from a control key.
  it.each([
    ['a printable character', { key: 'a' }, { kind: 'text', text: 'a' }],
    ['a space', { key: ' ' }, { kind: 'text', text: ' ' }],
    ['Backspace', { key: 'Backspace' }, { kind: 'backspace' }],
    ['Enter', { key: 'Enter' }, { kind: 'other' }],
    ['ArrowLeft', { key: 'ArrowLeft' }, { kind: 'other' }],
    ['a ctrl chord', { key: 'c', ctrlKey: true }, { kind: 'other' }],
    ['a meta chord', { key: 'v', metaKey: true }, { kind: 'other' }],
    ['an alt chord', { key: 'b', altKey: true }, { kind: 'other' }],
  ])('classifies the echo for %s', (_label, init, echo) => {
    const { onBytes, el } = setup(() => [1]);
    fireEvent.keyDown(el, init);

    expect(onBytes).toHaveBeenCalledWith([1], echo);
  });
});

describe('TouchTermInput — IME keydowns are dropped, not guessed at', () => {
  // Each of these is a real signal that the key carries no usable value; the
  // text arrives later through composition or the drain.
  it.each([
    ['Android Gboard keyCode 229', { key: 'Unidentified', keyCode: 229 }],
    ["key 'Unidentified'", { key: 'Unidentified' }],
    ["key 'Process'", { key: 'Process' }],
    ['a composing keydown', { key: 'a', isComposing: true }],
  ])('ignores %s without consulting the key mapping', (_label, init) => {
    const { onBytes, keyToBytes, el } = setup();
    fireEvent.keyDown(el, init);

    expect(onBytes).not.toHaveBeenCalled();
    expect(keyToBytes).not.toHaveBeenCalled();
  });

  it('ignores keydowns for the whole composition, then sends the composed text once', () => {
    const { onBytes, el } = setup();

    fireEvent.compositionStart(el);
    fireEvent.keyDown(el, { key: 'n' });
    fireEvent.keyDown(el, { key: 'i' });
    expect(onBytes).not.toHaveBeenCalled();

    fireEvent.compositionEnd(el, { data: '你' });

    expect(onBytes).toHaveBeenCalledTimes(1);
    expect(onBytes.mock.calls[0][1]).toEqual({ kind: 'text', text: '你' });
  });

  it('resumes normal keydown handling after the composition ends', () => {
    const { onBytes, el } = setup(() => [65]);

    fireEvent.compositionStart(el);
    fireEvent.compositionEnd(el, { data: 'x' });
    onBytes.mockClear();

    fireEvent.keyDown(el, { key: 'a' });
    expect(onBytes).toHaveBeenCalledWith([65], { kind: 'text', text: 'a' });
  });

  it('clears the textarea after a composition so the next one starts empty', () => {
    const { el } = setup();
    el.value = '你';

    fireEvent.compositionStart(el);
    fireEvent.compositionEnd(el, { data: '你' });

    expect(el.value).toBe('');
  });
});

describe('TouchTermInput — the onInput drain catches whatever beforeinput did not', () => {
  it('sends whatever landed in the textarea and empties it', () => {
    const { onBytes, el } = setup();
    el.value = 'hi';

    fireEvent.input(el);

    expect(onBytes).toHaveBeenCalledWith([104, 105], { kind: 'text', text: 'hi' });
    // Left dirty, the next drain would resend everything.
    expect(el.value).toBe('');
  });

  it('stays quiet while a composition is in flight', () => {
    const { onBytes, el } = setup();

    fireEvent.compositionStart(el);
    el.value = 'partial';
    fireEvent.input(el);

    expect(onBytes).not.toHaveBeenCalled();
    expect(el.value).toBe('partial');
  });

  it('sends nothing when there is nothing to drain', () => {
    const { onBytes, el } = setup();
    el.value = '';

    fireEvent.input(el);

    expect(onBytes).not.toHaveBeenCalled();
  });
});

describe('TouchTermInput — text goes on the wire as UTF-8', () => {
  // A terminal takes bytes. Sending char codes would corrupt anything
  // non-ASCII, which is most of the keyboards this component exists for.
  it.each([
    ['ASCII', 'AB', [65, 66]],
    ['a Latin-1 accent', 'é', [195, 169]],
    ['a CJK character', '中', [228, 184, 173]],
    ['an emoji (surrogate pair)', '😀', [240, 159, 152, 128]],
  ])('encodes %s as UTF-8 bytes', (_label, text, bytes) => {
    const { onBytes, el } = setup();
    el.value = text;

    fireEvent.input(el);

    expect(onBytes).toHaveBeenCalledWith(bytes, { kind: 'text', text });
  });
});

describe('TouchTermInput — the native beforeinput path carries Android soft-keyboard edits (F-75)', () => {
  // Android Gboard sends keyCode 229 for every key, so keydown is dropped and
  // the edit arrives only as a native `beforeinput` InputEvent. React's
  // synthetic onBeforeInput never sees that event (react-dom builds it from
  // compositionend/keypress/textInput/paste, none of which carry inputType),
  // so these are dispatched as real InputEvents, the way the browser does.
  function beforeInput(el: HTMLElement, inputType: string, data: string | null = null) {
    const ev = new InputEvent('beforeinput', {
      inputType,
      data,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(ev);
    return ev;
  }

  it('sends DEL for deleteContentBackward (Android backspace)', () => {
    const { onBytes, el } = setup();

    const ev = beforeInput(el, 'deleteContentBackward');

    expect(onBytes).toHaveBeenCalledTimes(1);
    expect(onBytes).toHaveBeenCalledWith([127], { kind: 'backspace' });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('sends CR for insertLineBreak (Android Enter)', () => {
    const { onBytes, el } = setup();

    const ev = beforeInput(el, 'insertLineBreak');

    expect(onBytes).toHaveBeenCalledTimes(1);
    expect(onBytes).toHaveBeenCalledWith([13], { kind: 'other' });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('sends CR for insertParagraph (Enter on keyboards that report a paragraph break)', () => {
    const { onBytes, el } = setup();

    const ev = beforeInput(el, 'insertParagraph');

    expect(onBytes).toHaveBeenCalledTimes(1);
    expect(onBytes).toHaveBeenCalledWith([13], { kind: 'other' });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('sends insertText exactly once, even if an input event follows', () => {
    const { onBytes, el } = setup();

    const ev = beforeInput(el, 'insertText', 'a');
    // The text was preventDefault'ed, so nothing landed in the textarea and a
    // trailing input event has nothing to drain — no second send.
    expect(ev.defaultPrevented).toBe(true);
    fireEvent.input(el);

    expect(onBytes).toHaveBeenCalledTimes(1);
    expect(onBytes).toHaveBeenCalledWith([97], { kind: 'text', text: 'a' });
    expect(el.value).toBe('');
  });

  it('leaves edits alone while a composition is in flight', () => {
    const { onBytes, el } = setup();

    fireEvent.compositionStart(el);
    const ev = beforeInput(el, 'insertText', 'x');

    expect(onBytes).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('TouchTermInput — the internal ref does not steal the forwarded one', () => {
  // PaneBox focuses the textarea from its tap handler through the forwarded
  // ref; the native listener needs its own handle to the same element.
  it('still hands the textarea to an object ref', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<TouchTermInput ref={ref} onBytes={vi.fn()} keyToBytes={() => null} />);

    expect(ref.current).toBe(screen.getByLabelText('terminal input'));
  });

  it('still hands the textarea to a callback ref', () => {
    const ref = vi.fn();
    render(<TouchTermInput ref={ref} onBytes={vi.fn()} keyToBytes={() => null} />);

    expect(ref).toHaveBeenCalledWith(screen.getByLabelText('terminal input'));
  });

  it('removes the native listener on unmount', () => {
    const onBytes = vi.fn();
    const { unmount } = render(<TouchTermInput onBytes={onBytes} keyToBytes={() => null} />);
    const el = screen.getByLabelText('terminal input');

    unmount();
    el.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true })
    );

    expect(onBytes).not.toHaveBeenCalled();
  });
});
