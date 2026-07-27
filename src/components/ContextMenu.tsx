import { useEffect, useState, useCallback } from 'react';

interface MenuState {
  x: number;
  y: number;
  /** Selected text at the time the menu opened (output selection or field selection). */
  selectionText: string;
  /** The editable input/textarea to paste into, if any. */
  pasteTarget: HTMLInputElement | HTMLTextAreaElement | null;
  /** Element to "Select All" within (an input, or a scrollable output region). */
  selectAllTarget: HTMLElement | null;
}

function closestEditable(node: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  let el = node as HTMLElement | null;
  while (el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return el as HTMLInputElement | HTMLTextAreaElement;
    }
    el = el.parentElement;
  }
  return null;
}

function closestOutput(node: EventTarget | null): HTMLElement | null {
  let el = node as HTMLElement | null;
  while (el) {
    if (el.classList && (el.classList.contains('pane-output') || el.classList.contains('vt-screen'))) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function currentSelectionText(field: HTMLInputElement | HTMLTextAreaElement | null): string {
  // A focused field's selection is not part of window.getSelection().
  if (field && field.selectionStart != null && field.selectionEnd != null && field.selectionStart !== field.selectionEnd) {
    return field.value.slice(field.selectionStart, field.selectionEnd);
  }
  return window.getSelection()?.toString() ?? '';
}

/**
 * Native-feeling right-click context menu with Copy / Paste / Select All.
 *
 * The desktop app previously had no context menu (only the Edit menu's
 * accelerators), which — combined with the focused-input copy bug — made
 * copy/paste feel broken. This renders a lightweight menu and routes Paste
 * through `execCommand('insertText')` so the React-controlled command input's
 * onChange fires and its value stays in sync.
 */
export function ContextMenu(): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => {
      const field = closestEditable(e.target);
      const output = closestOutput(e.target);
      const selectionText = currentSelectionText(field);

      // Nothing actionable here (e.g. chrome / drag regions) — let the OS menu be.
      if (!field && !output && !selectionText) return;

      e.preventDefault();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        selectionText,
        pasteTarget: field,
        selectAllTarget: field ?? output,
      });
    };

    const onPointerDown = (e: MouseEvent): void => {
      // Close on any click that isn't on the menu itself.
      const el = e.target as HTMLElement | null;
      if (el && el.closest('[data-rysh-context-menu]')) return;
      close();
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };

    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [close]);

  if (!menu) return null;

  const canCopy = menu.selectionText.length > 0;
  const canPaste = menu.pasteTarget != null;
  const canSelectAll = menu.selectAllTarget != null;

  const doCopy = async (): Promise<void> => {
    close();
    if (!menu.selectionText) return;
    try {
      await navigator.clipboard.writeText(menu.selectionText);
    } catch {
      // Fall back to the synchronous copy command on the live selection.
      document.execCommand('copy');
    }
  };

  const doPaste = async (): Promise<void> => {
    const target = menu.pasteTarget;
    close();
    if (!target) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;
    target.focus();
    // execCommand('insertText') inserts at the caret AND fires a native `input`
    // event, so the React-controlled input's onChange updates store state.
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      // Manual fallback: splice at the caret and dispatch an input event.
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const next = target.value.slice(0, start) + text + target.value.slice(end);
      const setter = Object.getOwnPropertyDescriptor(
        target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(target, next);
      const caret = start + text.length;
      target.setSelectionRange(caret, caret);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  const doSelectAll = (): void => {
    const target = menu.selectAllTarget;
    close();
    if (!target) return;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      (target as HTMLInputElement).focus();
      (target as HTMLInputElement).select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  };

  // Keep the menu on-screen.
  const left = Math.min(menu.x, window.innerWidth - 180);
  const top = Math.min(menu.y, window.innerHeight - 110);

  const itemStyle = (enabled: boolean): React.CSSProperties => ({
    padding: '4px 14px',
    fontSize: 13,
    color: enabled ? '#d4d4d4' : '#666',
    cursor: enabled ? 'pointer' : 'default',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  });

  const Item = ({
    label,
    accel,
    enabled,
    onClick,
  }: {
    label: string;
    accel: string;
    enabled: boolean;
    onClick: () => void;
  }): JSX.Element => (
    <div
      style={itemStyle(enabled)}
      onMouseDown={(e) => {
        e.preventDefault();
        if (enabled) onClick();
      }}
      onMouseEnter={(e) => {
        if (enabled) (e.currentTarget as HTMLDivElement).style.background = '#094771';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = 'transparent';
      }}
    >
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
        <span>{label}</span>
        <span style={{ color: enabled ? '#888' : '#555' }}>{accel}</span>
      </span>
    </div>
  );

  const isMac = navigator.platform.toLowerCase().includes('mac');
  const mod = isMac ? '⌘' : 'Ctrl+';

  return (
    <div
      data-rysh-context-menu
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 10000,
        minWidth: 160,
        background: '#252526',
        border: '1px solid #454545',
        borderRadius: 5,
        boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
        padding: '4px 0',
        fontFamily: 'inherit',
      }}
    >
      <Item label="Copy" accel={`${mod}C`} enabled={canCopy} onClick={() => void doCopy()} />
      <Item label="Paste" accel={`${mod}V`} enabled={canPaste} onClick={() => void doPaste()} />
      <div style={{ height: 1, background: '#3a3a3a', margin: '4px 0' }} />
      <Item label="Select All" accel={`${mod}A`} enabled={canSelectAll} onClick={doSelectAll} />
    </div>
  );
}
