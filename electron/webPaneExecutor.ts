// webPaneExecutor.ts — Electron port of the Chrome-extension browser-action
// executor (rysh-chrome-plugin/src/services/browser-executor.ts).
//
// The Chrome version drives pages via chrome.scripting.executeScript({world:'MAIN',
// func, args}). Electron's WebContentsView has no func-injection API: we instead
// build JS code STRINGS and run them through WebPaneManager.executeJavaScript,
// which evaluates them in the page main world and returns the last expression's
// value (must be JSON-serializable). Params are interpolated safely via
// JSON.stringify so page input can never break out into executable code.
//
// Each snippet is an IIFE returning a JSON-serializable object so the manager's
// `result` field carries the action outcome. The behavior of the ~25 action
// handlers and their result shapes mirror the Chrome implementation exactly.

import { clipboard } from 'electron'
import type { WebPaneManager } from './webPaneManager'

export interface BrowserActionResult {
  success: boolean
  result?: any
  error?: string
  screenshot?: string
}

// ── Selector resolver source ──────────────────────────────────────────────
//
// Ported verbatim (in behavior) from selector-resolver.ts. Defines
// window.__rysh_resolve_selector in the page main world, guarded so re-injection
// is idempotent. Supports: xpath:/// , text:, aria:, role:, testid:, default CSS;
// optional text filter; prefers visible elements; returns pool[index].
const SELECTOR_RESOLVER_SOURCE = `(function () {
  if (window.__rysh_resolve_selector) return;
  window.__rysh_resolve_selector = function (selector, text, index) {
    if (index === undefined || index === null) index = 0;
    var candidates = [];

    if (selector.indexOf('xpath:') === 0 || selector.indexOf('//') === 0) {
      var xpath = selector.indexOf('xpath:') === 0 ? selector.slice(6) : selector;
      var result = document.evaluate(
        xpath, document, null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
      );
      for (var i = 0; i < result.snapshotLength; i++) {
        var node = result.snapshotItem(i);
        if (node instanceof Element) candidates.push(node);
      }

    } else if (selector.indexOf('text:') === 0) {
      var searchText = selector.slice(5).toLowerCase();
      var all = document.querySelectorAll('*');
      var matches = [];
      all.forEach(function (el) {
        var directText = Array.prototype.slice.call(el.childNodes)
          .filter(function (n) { return n.nodeType === Node.TEXT_NODE; })
          .map(function (n) { return n.textContent || ''; })
          .join('');
        if (directText.toLowerCase().indexOf(searchText) !== -1) {
          matches.push(el);
        }
      });
      if (matches.length === 0) {
        all.forEach(function (el) {
          if (el.textContent && el.textContent.toLowerCase().indexOf(searchText) !== -1) {
            matches.push(el);
          }
        });
        matches.sort(function (a, b) {
          return (a.textContent ? a.textContent.length : 0) - (b.textContent ? b.textContent.length : 0);
        });
      }
      candidates = matches;

    } else if (selector.indexOf('aria:') === 0) {
      var label = selector.slice(5);
      candidates = Array.prototype.slice.call(
        document.querySelectorAll('[aria-label="' + CSS.escape(label) + '"], [aria-labelledby="' + CSS.escape(label) + '"]')
      );

    } else if (selector.indexOf('role:') === 0) {
      var role = selector.slice(5);
      candidates = Array.prototype.slice.call(document.querySelectorAll('[role="' + CSS.escape(role) + '"]'));

    } else if (selector.indexOf('testid:') === 0) {
      var testid = selector.slice(7);
      candidates = Array.prototype.slice.call(document.querySelectorAll('[data-testid="' + CSS.escape(testid) + '"]'));

    } else {
      try {
        candidates = Array.prototype.slice.call(document.querySelectorAll(selector));
      } catch (e) {
        return null;
      }
    }

    if (text) {
      var lowerText = text.toLowerCase();
      candidates = candidates.filter(function (el) {
        return el.textContent && el.textContent.toLowerCase().indexOf(lowerText) !== -1;
      });
    }

    var visible = candidates.filter(function (el) {
      var rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    var pool = visible.length > 0 ? visible : candidates;
    return pool[index] != null ? pool[index] : null;
  };
})();`

// Actions that target a DOM element via the resolver. The resolver is injected
// before any of these run.
const RESOLVER_ACTIONS = new Set([
  'click', 'type', 'select', 'check', 'hover', 'get_text', 'get_html',
  'get_elements', 'get_value', 'scroll', 'press_key', 'drag_drop', 'wait',
])

// ── Public entrypoint ──────────────────────────────────────────────────────

/**
 * Execute a browser action against a single embedded web pane. Never throws:
 * failures (including thrown errors and in-page {error} results) are returned as
 * { success: false, error }.
 */
export async function executeBrowserAction(
  manager: WebPaneManager,
  paneId: string,
  action: string,
  params: Record<string, any>,
): Promise<BrowserActionResult> {
  // Trusted input is routed by webContents focus, so typeTrusted / pressKeyTrusted
  // / pasteTrusted have to call wc.focus() on the page they drive. That is a
  // background pane taking the keyboard out from under the user — the same
  // complaint as pane focus stealing, one layer down: an agent typing into a web
  // pane swallowed the words you were typing into a terminal pane. If the
  // renderer held focus when the action started, hand it straight back when the
  // action ends. If it did not (the user is working inside the page itself),
  // leave focus where the user put it.
  const host = manager.getHostWebContents()
  const restoreHost = !!host && !host.isDestroyed() && host.isFocused()

  try {
    if (RESOLVER_ACTIONS.has(action)) {
      // Inject the selector resolver (idempotent). Failures are non-fatal: the
      // in-page handlers report "Selector resolver not injected" if it's absent.
      await manager.executeJavaScript(paneId, SELECTOR_RESOLVER_SOURCE)
    }

    switch (action) {
      case 'navigate':     return await navigate(manager, paneId, params)
      case 'click':        return await runDom(manager, paneId, clickCode(params))
      case 'type':         return await typeTrusted(manager, paneId, params)
      case 'select':       return await runDom(manager, paneId, selectCode(params))
      case 'check':        return await runDom(manager, paneId, checkCode(params))
      case 'scroll':       return await runDom(manager, paneId, scrollCode(params))
      case 'hover':        return await runDom(manager, paneId, hoverCode(params))
      case 'wait':         return await runDom(manager, paneId, waitCode(params))
      case 'screenshot':   return await screenshot(manager, paneId, params)
      case 'get_text':     return await getText(manager, paneId, params)
      case 'get_html':     return await runDom(manager, paneId, getHtmlCode(params))
      case 'get_elements': return await runDom(manager, paneId, getElementsCode(params))
      case 'get_value':    return await runDom(manager, paneId, getValueCode(params))
      case 'get_tabs':     return getTabs(manager, paneId)
      case 'switch_tab':   return tabUnsupported()
      case 'new_tab':      return tabUnsupported()
      case 'close_tab':    return tabUnsupported()
      case 'back':         return await back(manager, paneId)
      case 'forward':      return await forward(manager, paneId)
      case 'reload':       return await reload(manager, paneId)
      case 'execute_js':   return await executeJs(manager, paneId, params)
      case 'press_key':    return await pressKeyTrusted(manager, paneId, params)
      case 'paste':        return await pasteTrusted(manager, paneId, params)
      case 'drag_drop':    return await runDom(manager, paneId, dragDropCode(params))
      default:             return { success: false, error: `Unknown action: ${action}` }
    }
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) }
  } finally {
    if (restoreHost && host && !host.isDestroyed() && !host.isFocused()) {
      host.focus()
    }
  }
}

// ── DOM-snippet runner ──────────────────────────────────────────────────────

/**
 * Run a code string in the page and turn its return value into a
 * BrowserActionResult. Mirrors the Chrome version: an in-page object carrying an
 * `error` field becomes a failure result; anything else becomes success.
 */
async function runDom(
  manager: WebPaneManager,
  paneId: string,
  code: string,
): Promise<BrowserActionResult> {
  const exec = await manager.executeJavaScript(paneId, code)
  if (!exec.ok) {
    return { success: false, error: exec.error || 'execution failed' }
  }
  const result = exec.result as any
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return { success: false, error: result.error }
  }
  return { success: true, result }
}

// ── Element interaction code builders ───────────────────────────────────────

function clickCode(params: { selector?: string; text?: string; index?: number }): string {
  if (!params.selector) return errorIife('Missing required parameter: selector')
  const selector = JSON.stringify(params.selector)
  const text = JSON.stringify(params.text ?? null)
  const index = JSON.stringify(params.index ?? 0)
  return `(function () {
    var resolve = window.__rysh_resolve_selector;
    if (!resolve) return { error: 'Selector resolver not injected' };
    var el = resolve(${selector}, ${text}, ${index});
    if (!el) return { error: 'Element not found: ' + ${selector} };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.click();
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().substring(0, 200),
      clicked: true,
    };
  })();`
}

// ── Trusted input (DevTools protocol) ──────────────────────────────────────
//
// type/press_key inject through the pane's webContents.debugger using CDP
// Input.* commands — an EXACT port of rysh-cli/internal/cdp/actions.go, the
// path lab-verified against Medium's editor. Electron's sendInputEvent was
// NOT sufficient: it edits the DOM via Blink's low-level path, but controlled
// editors (Draft.js / ProseMirror) never register the input in their model —
// text lands in textContent while the editor still renders its placeholder
// and would publish empty. CDP-dispatched events run the full event pipeline.

type InputModifier = 'shift' | 'control' | 'alt' | 'meta'

function mapModifiers(mods: string[] | undefined): InputModifier[] {
  const out: InputModifier[] = []
  for (const m of mods ?? []) {
    switch (m.toLowerCase()) {
      case 'shift': out.push('shift'); break
      case 'ctrl': case 'control': out.push('control'); break
      case 'alt': case 'option': out.push('alt'); break
      case 'meta': case 'cmd': case 'command': out.push('meta'); break
    }
  }
  return out
}

const CDP_KEY_CODES: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32,
}
// The character a named key TYPES (CDP keyDown.text). Without it, Enter/
// Space/Tab move focus but insert nothing — breaking editor shortcuts that
// trigger on a real typed space.
const CDP_KEY_TEXT: Record<string, string> = { Enter: '\r', Space: ' ', Tab: '\t' }
// Physical modifier keys, pressed down before the main key and released
// after — editors track the modifier keydown itself, not just flag bits.
const CDP_MODIFIERS: Array<{ name: InputModifier; bit: number; key: string; vk: number }> = [
  { name: 'alt', bit: 1, key: 'Alt', vk: 18 },
  { name: 'control', bit: 2, key: 'Control', vk: 17 },
  { name: 'meta', bit: 4, key: 'Meta', vk: 91 },
  { name: 'shift', bit: 8, key: 'Shift', vk: 16 },
]

async function cdpKeyEvent(
  manager: WebPaneManager,
  paneId: string,
  params: Record<string, unknown>,
): Promise<void> {
  const r = await manager.cdpSend(paneId, 'Input.dispatchKeyEvent', params)
  if (!r.ok) throw new Error(r.error || 'Input.dispatchKeyEvent failed')
}

async function cdpInsertText(manager: WebPaneManager, paneId: string, text: string): Promise<void> {
  const r = await manager.cdpSend(paneId, 'Input.insertText', { text })
  if (!r.ok) throw new Error(r.error || 'Input.insertText failed')
}

/** One full trusted key press via CDP, with physical modifier wrapping. */
async function cdpPressOnce(
  manager: WebPaneManager,
  paneId: string,
  key: string,
  modifiers: InputModifier[] = [],
): Promise<void> {
  let bits = 0
  const held: Array<{ bit: number; key: string; vk: number }> = []
  for (const mod of CDP_MODIFIERS) {
    if (modifiers.includes(mod.name)) {
      await cdpKeyEvent(manager, paneId, {
        type: 'keyDown', key: mod.key, modifiers: bits,
        windowsVirtualKeyCode: mod.vk, nativeVirtualKeyCode: mod.vk,
      })
      bits |= mod.bit
      held.push(mod)
    }
  }
  try {
    const vkNamed = CDP_KEY_CODES[key]
    if (vkNamed !== undefined) {
      const down: Record<string, unknown> = {
        type: 'keyDown', key, modifiers: bits,
        windowsVirtualKeyCode: vkNamed, nativeVirtualKeyCode: vkNamed,
      }
      const text = CDP_KEY_TEXT[key]
      if (text !== undefined) down.text = text
      await cdpKeyEvent(manager, paneId, down)
      await cdpKeyEvent(manager, paneId, {
        type: 'keyUp', key, modifiers: bits,
        windowsVirtualKeyCode: vkNamed, nativeVirtualKeyCode: vkNamed,
      })
    } else if ([...key].length === 1) {
      if (bits !== 0) {
        // Shortcut combos need real keyDown/keyUp with a virtual key code —
        // a bare char event never reaches accelerator handling.
        let vk = 0
        if (key >= '0' && key <= '9') vk = key.charCodeAt(0)
        else {
          const upper = key.toUpperCase().charCodeAt(0)
          if (upper >= 65 && upper <= 90) vk = upper
        }
        const down: Record<string, unknown> = { type: 'keyDown', key, modifiers: bits }
        const up: Record<string, unknown> = { type: 'keyUp', key, modifiers: bits }
        if (vk !== 0) {
          down.windowsVirtualKeyCode = vk
          down.nativeVirtualKeyCode = vk
          up.windowsVirtualKeyCode = vk
          up.nativeVirtualKeyCode = vk
        }
        await cdpKeyEvent(manager, paneId, down)
        await cdpKeyEvent(manager, paneId, up)
      } else {
        await cdpKeyEvent(manager, paneId, { type: 'char', key, text: key, modifiers: bits })
      }
    } else {
      await cdpKeyEvent(manager, paneId, { type: 'keyDown', key, modifiers: bits })
      await cdpKeyEvent(manager, paneId, { type: 'keyUp', key, modifiers: bits })
    }
  } finally {
    for (let i = held.length - 1; i >= 0; i--) {
      const mod = held[i]
      bits &= ~mod.bit
      try {
        await cdpKeyEvent(manager, paneId, {
          type: 'keyUp', key: mod.key, modifiers: bits,
          windowsVirtualKeyCode: mod.vk, nativeVirtualKeyCode: mod.vk,
        })
      } catch {
        // best-effort modifier release
      }
    }
  }
}

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Focus the target and (optionally) select its existing content so the first
 * trusted keystroke/insert replaces it. Selection manipulation via JS is fine
 * — only the INPUT events themselves must be trusted.
 */
function focusForInputCode(selector: string, clear: boolean): string {
  const sel = JSON.stringify(selector)
  return `(function () {
    var resolve = window.__rysh_resolve_selector;
    if (!resolve) return { error: 'Selector resolver not injected' };
    var el = resolve(${sel});
    if (!el) return { error: 'Element not found: ' + ${sel} };
    el.scrollIntoView({ block: 'center' });
    // CRITICAL: for a node INSIDE a contenteditable region, .focus() on the
    // node is a NO-OP — focus belongs to the editable HOST. Without focusing
    // the host, a rich-text editor with multiple editable fields (Medium:
    // separate title + body hosts) keeps focus on the previous field and
    // trusted insertText lands THERE (observed: body text typed into the
    // title). Focus the host, then place the selection inside the target.
    var host = el.isContentEditable && el.closest ? el.closest('[contenteditable="true"]') : null;
    (host || el).focus();
    var hadText = false;
    if (${JSON.stringify(clear)}) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        hadText = el.value.length > 0;
        if (hadText) el.select();
      } else if (el.isContentEditable) {
        hadText = (el.textContent || '').length > 0;
        if (hadText) {
          var range = document.createRange();
          range.selectNodeContents(el);
          var s = window.getSelection();
          s.removeAllRanges();
          s.addRange(range);
        }
      }
    } else if (el.isContentEditable) {
      var r2 = document.createRange();
      r2.selectNodeContents(el);
      r2.collapse(false); // caret to end for append
      var s2 = window.getSelection();
      s2.removeAllRanges();
      s2.addRange(r2);
    }
    return { focused: true, hadText: hadText, editable: !!el.isContentEditable };
  })();`
}

/** Read back what the element now contains (for the action result). */
function readBackCode(selector: string): string {
  const sel = JSON.stringify(selector)
  return `(function () {
    var resolve = window.__rysh_resolve_selector;
    var el = resolve ? resolve(${sel}) : null;
    if (!el) return { error: 'Element not found: ' + ${sel} };
    return { value: el.value !== undefined ? el.value : (el.textContent || '') };
  })();`
}

async function typeTrusted(
  manager: WebPaneManager,
  paneId: string,
  params: { selector?: string; text?: string; clear?: boolean; keystrokes?: boolean }
): Promise<BrowserActionResult> {
  if (!params.selector) return { success: false, error: 'Missing required parameter: selector' }
  if (params.text === undefined) return { success: false, error: 'Missing required parameter: text' }
  const wc = manager.getWebContents(paneId)
  if (!wc) return { success: false, error: 'no such web pane' }
  wc.focus() // input events follow webContents focus, not window focus

  const focus = await runDom(manager, paneId, focusForInputCode(params.selector, params.clear ?? true))
  if (!focus.success) return focus
  // clear=true leaves the existing content SELECTED; the first trusted
  // insertion below REPLACES the selection atomically inside the editor's
  // own pipeline. Never send a standalone delete here: a trusted Backspace
  // on a selected field can remove the field's ELEMENT in structured
  // editors (observed on Medium's title h3 — it only exists on a fresh
  // page load, and deleting it leaves an unrecoverable ghost-placeholder
  // title that the editor's model treats as empty).
  // Exception: an explicit empty-text clear has nothing to replace the
  // selection with, so the delete is the caller's stated intent.
  if ((params.clear ?? true) && String(params.text) === '' && (focus.result as any)?.hadText) {
    await cdpPressOnce(manager, paneId, 'Backspace')
    await settle(30)
  }

  const segments = String(params.text).split('\n')
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (params.keystrokes) {
      // Per-character trusted keystrokes: needed when editor default text /
      // markdown shortcuts only react to actual key events.
      for (const ch of seg) await cdpPressOnce(manager, paneId, ch === ' ' ? 'Space' : ch)
    } else if (seg.length > 0) {
      // Bulk trusted insertion (CDP Input.insertText): replaces the active
      // selection and runs the editor's own insert pipeline — no revert.
      await cdpInsertText(manager, paneId, seg)
    }
    if (i < segments.length - 1) {
      await cdpPressOnce(manager, paneId, 'Enter')
      await settle(30)
    }
  }
  await settle(60) // let the editor's render/model tick absorb the input

  const back = await runDom(manager, paneId, readBackCode(params.selector))
  const value = back.success ? (back.result as any)?.value : undefined
  return {
    success: true,
    result: { typed: params.text, selector: params.selector, value, trusted: true },
  }
}


/**
 * Native paste (trusted, full rich-paste pipeline). Optionally seeds the
 * system clipboard first: html gets the editor's rich conversion (e.g.
 * Medium turning HTML into native heading/list/code blocks), text is plain.
 * Synthetic Cmd+V key events can NEVER trigger the browser's paste command —
 * this is the only working path.
 */
async function pasteTrusted(
  manager: WebPaneManager,
  paneId: string,
  params: { html?: string; text?: string },
): Promise<BrowserActionResult> {
  const wc = manager.getWebContents(paneId)
  if (!wc) return { success: false, error: 'no such web pane' }
  wc.focus()
  if (params.html) {
    clipboard.write({
      html: params.html,
      text: params.text ?? params.html.replace(/<[^>]+>/g, ''),
    })
  } else if (params.text) {
    clipboard.writeText(params.text)
  } // else: paste whatever the system clipboard already holds
  wc.paste()
  await settle(400) // rich-paste conversion is async in most editors
  return {
    success: true,
    result: { pasted: true, source: params.html ? 'html' : params.text ? 'text' : 'system-clipboard' },
  }
}

async function pressKeyTrusted(
  manager: WebPaneManager,
  paneId: string,
  params: { key?: string; modifiers?: string[]; count?: number }
): Promise<BrowserActionResult> {
  if (!params.key) return { success: false, error: 'Missing required parameter: key' }
  const wc = manager.getWebContents(paneId)
  if (!wc) return { success: false, error: 'no such web pane' }
  wc.focus() // input events follow webContents focus, not window focus
  // count repeats one call N times (e.g. Backspace x 12) so legitimate
  // repetition never trips the identical-call loop guard.
  const count = Math.min(Math.max(1, params.count ?? 1), 200)
  for (let i = 0; i < count; i++) {
    await cdpPressOnce(manager, paneId, params.key, mapModifiers(params.modifiers))
    await settle(25)
  }
  return {
    success: true,
    result: { key: params.key, modifiers: params.modifiers ?? [], count, sent: true, trusted: true },
  }
}

function selectCode(params: { selector?: string; value?: string; text?: string }): string {
  if (!params.selector) return errorIife('Missing required parameter: selector')
  const selector = JSON.stringify(params.selector)
  const value = JSON.stringify(params.value ?? null)
  const text = JSON.stringify(params.text ?? null)
  return `(function () {
    var resolve = window.__rysh_resolve_selector;
    if (!resolve) return { error: 'Selector resolver not injected' };
    var el = resolve(${selector});
    if (!el) return { error: 'Element not found: ' + ${selector} };
    var value = ${value};
    var text = ${text};
    var options = Array.prototype.slice.call(el.options);
    var target = value
      ? options.find(function (o) { return o.value === value; })
      : options.find(function (o) { return (o.textContent || '').trim() === text; });
    if (!target) return { error: 'Option not found: ' + (value || text) };
    el.value = target.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: target.value, text: (target.textContent || '').trim() };
  })();`
}

function checkCode(params: { selector?: string; checked?: boolean }): string {
  if (!params.selector) return errorIife('Missing required parameter: selector')
  const selector = JSON.stringify(params.selector)
  const checked = JSON.stringify(params.checked ?? false)
  return `(function () {
    var resolve = window.__rysh_resolve_selector;
    if (!resolve) return { error: 'Selector resolver not injected' };
    var el = resolve(${selector});
    if (!el) return { error: 'Element not found: ' + ${selector} };
    var checked = ${checked};
    if (el.checked !== checked) el.click();
    return { checked: el.checked, selector: ${selector} };
  })();`
}

function hoverCode(params: { selector?: string }): string {
  if (!params.selector) return errorIife('Missing required parameter: selector')
  const selector = JSON.stringify(params.selector)
  return `(function () {
    var resolve = window.__rysh_resolve_selector;
    if (!resolve) return { error: 'Selector resolver not injected' };
    var el = resolve(${selector});
    if (!el) return { error: 'Element not found: ' + ${selector} };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    return { hovered: true, selector: ${selector} };
  })();`
}

function dragDropCode(params: { from_selector?: string; to_selector?: string }): string {
  if (!params.from_selector || !params.to_selector) {
    return errorIife('Missing required parameters: from_selector and to_selector')
  }
  const fromSel = JSON.stringify(params.from_selector)
  const toSel = JSON.stringify(params.to_selector)
  return `(function () {
    var from = document.querySelector(${fromSel});
    var to = document.querySelector(${toSel});
    if (!from || !to) return { error: 'Element not found' };
    var dataTransfer = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dataTransfer }));
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dataTransfer }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dataTransfer }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dataTransfer }));
    return { dragged: ${fromSel}, dropped: ${toSel} };
  })();`
}

// ── Scrolling ────────────────────────────────────────────────────────────────

function scrollCode(params: { direction?: string; amount?: number; selector?: string }): string {
  if (!params.direction) return errorIife('Missing required parameter: direction')
  const direction = JSON.stringify(params.direction ?? 'down')
  const amount = JSON.stringify(params.amount ?? 500)
  const selector = JSON.stringify(params.selector ?? null)
  return `(function () {
    var direction = ${direction};
    var amount = ${amount};
    var selector = ${selector};
    var target = selector ? document.querySelector(selector) : null;
    var scrollTarget = target || window;
    var px = amount || 500;
    var opts = { behavior: 'smooth' };
    switch (direction) {
      case 'down':  scrollTarget.scrollBy({ top: px, behavior: opts.behavior }); break;
      case 'up':    scrollTarget.scrollBy({ top: -px, behavior: opts.behavior }); break;
      case 'right': scrollTarget.scrollBy({ left: px, behavior: opts.behavior }); break;
      case 'left':  scrollTarget.scrollBy({ left: -px, behavior: opts.behavior }); break;
    }
    return { scrolled: direction, amount: px };
  })();`
}

// ── Waiting ────────────────────────────────────────────────────────────────

function waitCode(params: { selector?: string; timeout_ms?: number; visible?: boolean }): string {
  const selector = JSON.stringify(params.selector ?? null)
  const timeout = JSON.stringify(params.timeout_ms ?? 10000)
  const visible = JSON.stringify(params.visible ?? false)
  // The IIFE returns a Promise; Electron's executeJavaScript awaits it.
  return `(function () {
    var selector = ${selector};
    var timeoutMs = ${timeout};
    var needsVisible = ${visible};
    return new Promise(function (resolve) {
      if (!selector) {
        if (document.readyState === 'complete') return resolve({ ready: true });
        window.addEventListener('load', function () { resolve({ ready: true }); });
        setTimeout(function () { resolve({ ready: true, timeout: true }); }, timeoutMs);
        return;
      }
      var check = function () {
        var el = document.querySelector(selector);
        if (!el) return false;
        if (needsVisible) {
          var rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }
        return true;
      };
      if (check()) return resolve({ found: true, selector: selector });
      var observer = new MutationObserver(function () {
        if (check()) {
          observer.disconnect();
          resolve({ found: true, selector: selector });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      setTimeout(function () {
        observer.disconnect();
        resolve({ found: check(), selector: selector, timeout: true });
      }, timeoutMs);
    });
  })();`
}

// ── Content extraction code builders ────────────────────────────────────────

function getHtmlCode(params: { selector?: string; outer?: boolean }): string {
  const selector = JSON.stringify(params.selector ?? null)
  const outer = JSON.stringify(params.outer ?? false)
  return `(function () {
    var selector = ${selector};
    var outer = ${outer};
    var el = selector ? document.querySelector(selector) : document.body;
    if (!el) return { error: 'Element not found: ' + selector };
    var html = outer ? el.outerHTML : el.innerHTML;
    return { html: html.substring(0, 50000), length: html.length, truncated: html.length > 50000 };
  })();`
}

function getElementsCode(params: { selector?: string; attributes?: string[]; limit?: number }): string {
  if (!params.selector) return errorIife('Missing required parameter: selector')
  const selector = JSON.stringify(params.selector)
  const attributes = JSON.stringify(params.attributes ?? [])
  const limit = JSON.stringify(params.limit ?? 50)
  return `(function () {
    var selector = ${selector};
    var attributes = ${attributes};
    var limit = ${limit};
    var els;
    try {
      els = document.querySelectorAll(selector);
    } catch (e) {
      return { error: 'Invalid selector: ' + selector };
    }
    var items = [];
    var max = Math.min(els.length, limit);
    for (var i = 0; i < max; i++) {
      var el = els[i];
      var item = {
        index: i,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().substring(0, 200),
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
      };
      if (el.id) item.id = el.id;
      if (el.className && typeof el.className === 'string') item.class = el.className;
      for (var a = 0; a < attributes.length; a++) {
        var val = el.getAttribute(attributes[a]);
        if (val !== null) item[attributes[a]] = val;
      }
      items.push(item);
    }
    return { count: els.length, returned: items.length, elements: items };
  })();`
}

function getValueCode(params: { selector?: string }): string {
  if (!params.selector) return errorIife('Missing required parameter: selector')
  const selector = JSON.stringify(params.selector)
  return `(function () {
    var el = document.querySelector(${selector});
    if (!el) return { error: 'Element not found: ' + ${selector} };
    return { value: el.value, type: el.type, tag: el.tagName.toLowerCase() };
  })();`
}

// ── get_text (with manager.getPageContent fallback) ─────────────────────────

async function getText(
  manager: WebPaneManager,
  paneId: string,
  params: { selector?: string },
): Promise<BrowserActionResult> {
  // Settle one frame + a beat first: reads raced the editor's async render
  // and reported one step stale, causing wasted retries.
  await manager.executeJavaScript(paneId, 'new Promise(r => requestAnimationFrame(() => setTimeout(r, 80)))')
  const selector = JSON.stringify(params.selector ?? null)
  const code = `(function () {
    var selector = ${selector};
    var el = selector ? document.querySelector(selector) : document.body;
    if (!el) return { error: 'Element not found: ' + selector };
    var text = (el.textContent || '').trim();
    return { text: text.substring(0, 50000), length: text.length, truncated: text.length > 50000 };
  })();`

  const exec = await manager.executeJavaScript(paneId, code)
  if (exec.ok) {
    const result = exec.result as any
    if (!(result && typeof result === 'object' && typeof result.error === 'string')) {
      return { success: true, result }
    }
  }

  // Fall back to the manager's page-content extraction (whole-page text).
  const content = await manager.getPageContent(paneId)
  if (content) {
    const text = (content.text || '').trim()
    return {
      success: true,
      result: { text: text.substring(0, 50000), length: text.length, truncated: text.length > 50000 },
    }
  }

  const err = exec.ok ? (exec.result as any)?.error : exec.error
  return { success: false, error: err || 'failed to get text' }
}

// ── Navigation actions ───────────────────────────────────────────────────────

async function navigate(
  manager: WebPaneManager,
  paneId: string,
  params: { url?: string },
): Promise<BrowserActionResult> {
  if (!params.url) return { success: false, error: 'Missing required parameter: url' }
  manager.navigate(paneId, params.url)
  await waitForReady(manager, paneId)
  const info = manager.getInfo(paneId)
  if (!info) return { success: false, error: 'no such web pane' }
  return { success: true, result: { url: info.url, title: info.title } }
}

async function back(manager: WebPaneManager, paneId: string): Promise<BrowserActionResult> {
  manager.goBack(paneId)
  await waitForReady(manager, paneId)
  return { success: true, result: { status: 'navigated_back' } }
}

async function forward(manager: WebPaneManager, paneId: string): Promise<BrowserActionResult> {
  manager.goForward(paneId)
  await waitForReady(manager, paneId)
  return { success: true, result: { status: 'navigated_forward' } }
}

async function reload(manager: WebPaneManager, paneId: string): Promise<BrowserActionResult> {
  manager.reload(paneId)
  await waitForReady(manager, paneId)
  return { success: true, result: { status: 'reloaded' } }
}

// ── Screenshot ────────────────────────────────────────────────────────────────

async function screenshot(
  manager: WebPaneManager,
  paneId: string,
  params: Record<string, any> = {},
): Promise<BrowserActionResult> {
  // Same settle as getText: capture AFTER the pending render frame, so the
  // agent never reasons about a half-rendered page.
  //
  // `settle: false` skips it. That exists for run recording (##auto web run
  // --record), which captures a frame every few hundred milliseconds for the
  // whole run: settling there would inject JS into the page being automated
  // several times a second for minutes on end, and add its cost to every
  // frame. A recording wants a cheap sample of whatever is on screen right
  // now, and a torn frame is of no consequence in a video — unlike a
  // screenshot the model is about to reason about.
  if (params.settle !== false) {
    await manager.executeJavaScript(paneId, 'new Promise(r => requestAnimationFrame(() => setTimeout(r, 80)))')
  }
  // quality lets a caller trade fidelity for size; the default (40) is tuned
  // for the agent's occasional captures. Ignored unless in 1..100.
  const q = typeof params.quality === 'number' && params.quality > 0 && params.quality <= 100
    ? params.quality
    : undefined
  const base64 = await manager.captureScreenshotJPEG(paneId, q)
  if (base64 === null) {
    return { success: false, error: 'failed to capture screenshot' }
  }
  const info = manager.getInfo(paneId)
  return {
    success: true,
    result: {
      // NOTE: do NOT echo the base64 here too — duplicating it doubles the NATS
      // response payload and can push it past the broker's max-payload limit.
      format: 'jpeg',
      tab_title: info?.title,
      tab_url: info?.url,
      note: 'Screenshot captured as base64 JPEG; the image is in the top-level screenshot field.',
    },
    // The tool reads the image from the top-level screenshot field.
    screenshot: base64,
  }
}

// ── Tab management ───────────────────────────────────────────────────────────
//
// A web pane is a single embedded page: there are no tabs to enumerate or
// switch between. get_tabs reports the current view as one active tab; the
// mutating tab actions are unsupported.

function getTabs(manager: WebPaneManager, paneId: string): BrowserActionResult {
  const info = manager.getInfo(paneId)
  if (!info) return { success: false, error: 'no such web pane' }
  return {
    success: true,
    result: {
      tabs: [{ index: 0, title: info.title, url: info.url, active: true }],
    },
  }
}

function tabUnsupported(): BrowserActionResult {
  return { success: false, error: 'tab management is not supported in an embedded web pane' }
}

// ── JavaScript execution ─────────────────────────────────────────────────────

async function executeJs(
  manager: WebPaneManager,
  paneId: string,
  params: { code?: string },
): Promise<BrowserActionResult> {
  if (!params.code) return { success: false, error: 'Missing required parameter: code' }
  // Electron swallows in-page exceptions into a generic "Script failed to
  // execute" rejection; wrap the code so the REAL error message (and top
  // stack frame) comes back as data instead.
  const safe = `(function () {
    try { return { result: eval(${JSON.stringify(params.code)}) }; }
    catch (e) {
      var st = ((e && e.stack) || '').split('\n')[1] || '';
      return { error: 'js: ' + ((e && e.message) || String(e)) + (st ? ' @' + st.trim() : '') };
    }
  })();`
  return await runDom(manager, paneId, safe)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** IIFE that returns an {error} object — used for missing-parameter checks. */
function errorIife(message: string): string {
  return `(function () { return { error: ${JSON.stringify(message)} }; })();`
}

/**
 * Poll document.readyState until the page is 'complete' or a short timeout
 * elapses, replicating the Chrome version's post-navigation settle. Each poll is
 * driven from the page itself via a setTimeout-backed Promise so we don't block
 * the main process with a foreground sleep.
 */
async function waitForReady(
  manager: WebPaneManager,
  paneId: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const exec = await manager.executeJavaScript(
      paneId,
      `new Promise(function (resolve) {
        if (document.readyState === 'complete') return resolve(true);
        setTimeout(function () { resolve(document.readyState === 'complete'); }, 250);
      });`,
    )
    if (exec.ok && exec.result === true) {
      // Small settle delay so post-load scripts can run, matching the Chrome path.
      await manager.executeJavaScript(
        paneId,
        `new Promise(function (resolve) { setTimeout(function () { resolve(true); }, 300); });`,
      )
      return
    }
    if (!exec.ok) {
      // Page is likely mid-navigation (context destroyed); retry after a beat.
      await manager.executeJavaScript(
        paneId,
        `new Promise(function (resolve) { setTimeout(function () { resolve(true); }, 250); });`,
      ).catch(() => undefined)
    }
  }
}
