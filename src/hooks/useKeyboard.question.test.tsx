import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useKeyboard } from './useKeyboard';
import { useStore } from '../store';
import type { PendingApproval } from '../types';

// F-92, desktop keys. In approval mode useKeyboard swallowed every key and
// mapped y/Y/n to the gate decisions. For ask_user's question that meant the
// answer field could never receive a "y" — typing "yes" sent Approve on the
// first letter — and the gate keys reached the model as an empty response.

function pending(type: string): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  const approval: PendingApproval = {
    pane_id: 'pane-1',
    request: { request_id: 'req-1', orchestrator_id: '', tool_call_id: 'req-1', type, description: 'q', choices: [] },
  };
  act(() => {
    useStore.setState({
      connected: true,
      ws: { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
      pendingApproval: approval,
      mode: 'approval',
    });
  });
  return send;
}

function sent(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls
    .map((c) => JSON.parse(c[0] as string))
    .filter((m) => m.type === 'command' && m.data.action === 'approval_response')
    .map((m) => m.data.params);
}

function press(key: string, target: EventTarget = document): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

afterEach(() => {
  act(() => {
    useStore.setState({ pendingApproval: null, mode: 'normal', ws: null, connected: false });
  });
  document.body.innerHTML = '';
});

describe('useKeyboard — a question is typed into, not approved', () => {
  it('lets "y" and "n" reach the answer field and sends nothing', () => {
    const send = pending('question');
    renderHook(() => useKeyboard());
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const y = press('y', input);
    const n = press('n', input);

    expect(sent(send)).toEqual([]);
    expect(y.defaultPrevented).toBe(false);
    expect(n.defaultPrevented).toBe(false);
    expect(useStore.getState().pendingApproval).not.toBeNull();
  });

  it('Escape declines the question', () => {
    const send = pending('question');
    renderHook(() => useKeyboard());

    press('Escape');

    expect(sent(send)).toEqual([{ pane_id: 'pane-1', request_id: 'req-1', decision: 'no', reason: '' }]);
  });

  it('a gate still approves on "y"', () => {
    const send = pending('destructive_action');
    renderHook(() => useKeyboard());

    press('y');

    expect(sent(send)).toEqual([{ pane_id: 'pane-1', request_id: 'req-1', decision: 'yes', reason: '' }]);
  });
});
