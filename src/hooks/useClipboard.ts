import { useEffect } from 'react';

/**
 * Returns true when the focused element is an <input>/<textarea> that has a
 * non-collapsed selection of its own.
 *
 * window.getSelection() does NOT include selections inside form fields, so a
 * field selection has to be detected via selectionStart/selectionEnd.
 */
function fieldHasOwnSelection(): boolean {
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  return start != null && end != null && start !== end;
}

/**
 * Clipboard fix for the desktop app.
 *
 * Each pane keeps DOM focus on a hidden command <input> so typed keys follow
 * pane navigation (see PaneInput). Chromium's copy command operates on the
 * *focused* element's selection — and highlighting text in a pane's output (a
 * non-editable region) does NOT blur that focused input. So "select output →
 * Cmd/Ctrl+C" copied the input's empty selection: nothing reached the
 * clipboard. This is the "copy doesn't work" bug in the Electron app.
 *
 * This hook intercepts the `copy`/`cut` events and, unless the focused field
 * has its own selection, copies the visible document selection instead. The
 * `copy` event fires both for the keyboard accelerator and the Edit ▸ Copy
 * menu role, so both paths are covered.
 */
export function useClipboard(): void {
  useEffect(() => {
    const onCopy = (e: ClipboardEvent): void => {
      // Let the browser handle copy/cut from an editable field that has its own
      // selection (e.g. text highlighted inside the command input).
      if (fieldHasOwnSelection()) return;

      const text = window.getSelection()?.toString() ?? '';
      if (!text) return;

      e.clipboardData?.setData('text/plain', text);
      e.preventDefault();
    };

    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
    };
  }, []);
}
