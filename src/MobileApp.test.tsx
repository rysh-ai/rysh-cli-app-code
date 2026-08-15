import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import MobileApp from './MobileApp';
import { useStore } from './store';
import type { PendingApproval, WorkspaceSnapshot } from './types';

// E-12b: a gated tool blocks in the TUI until someone answers it, and the phone
// could not answer. The data plane was never the gap — useWebSocket already puts
// the approval_request in the shared store, and the server's `approval_response`
// command (internal/web/server.go) publishes to the same subject the TUI does,
// which is what releases waitForApproval in the orchestrator. What was missing
// was a surface: MobileApp mounted no approval UI at all, and the desktop's
// answers were bound to the y/Y/n/N keys a phone does not have.
//
// So these tests pin the two halves of "a phone can approve": the dialog is
// REACHABLE on the phone (whatever screen it is on), and every answer the
// desktop keyboard can give is reachable by TAP, with the same wire payload.

// The socket is not under test here: MobileApp calls useWebSocket() to open the
// content plane, and jsdom would dial a real ws://localhost. Seed the store the
// way the socket would.
vi.mock('./hooks/useWebSocket', () => ({ useWebSocket: () => undefined }));

const SNAPSHOT: WorkspaceSnapshot = {
  tabs: [
    {
      id: 't1',
      title: 'build',
      active_pane_id: 'pane-1',
      lanes: [
        {
          id: 'l1',
          flex: 1,
          active_pane_id: 'pane-1',
          pane_groups: [
            {
              id: 'g1',
              active_pane_id: 'pane-1',
              panes: [
                {
                  id: 'pane-1',
                  title: 'claude',
                  flex: 1,
                  mode: 'prompt',
                  output: '',
                  status: 'waiting',
                  last_command: '',
                  provider_name: '',
                  attention_count: 1,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  active_tab_id: 't1',
  active_pane_id: 'pane-1',
};

const APPROVAL: PendingApproval = {
  pane_id: 'pane-1',
  request: {
    request_id: 'req-7',
    orchestrator_id: 'orc-1',
    tool_call_id: 'call-1',
    type: 'bash',
    description: 'Run: rm -rf build/',
    choices: [],
  },
};

/** Seed a connected phone with a tool waiting on an answer. */
function pendingOnPhone(approval: PendingApproval | null = APPROVAL) {
  const send = vi.fn();
  act(() => {
    useStore.setState({
      snapshot: SNAPSHOT,
      connected: true,
      ws: { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
      pendingApproval: approval,
      mode: approval ? 'approval' : 'normal',
    });
  });
  return send;
}

/** The single approval_response params object sent through the socket. */
function approvalSent(send: ReturnType<typeof vi.fn>) {
  const msgs = send.mock.calls
    .map((c) => JSON.parse(c[0] as string))
    .filter((m) => m.type === 'command' && m.data.action === 'approval_response');
  return msgs.map((m) => m.data.params);
}

afterEach(() => {
  act(() => {
    useStore.setState({
      snapshot: null,
      connected: false,
      ws: null,
      pendingApproval: null,
      approvalError: null,
      mode: 'normal',
    });
  });
});

describe('MobileApp — approving a gated tool from the phone', () => {
  it('shows the waiting tool without being on the pane that raised it', () => {
    pendingOnPhone();
    render(<MobileApp />);

    // The phone opens on the tab list; an approval that can only be seen after
    // drilling into the right pane is an approval nobody answers.
    expect(screen.getByText('Run: rm -rf build/')).toBeInTheDocument();
  });

  it('shows nothing when no tool is waiting', () => {
    pendingOnPhone(null);
    render(<MobileApp />);

    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
  });

  it('approves with a tap, releasing the tool waiting in the TUI', () => {
    const send = pendingOnPhone();
    render(<MobileApp />);

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));

    expect(approvalSent(send)).toEqual([
      { pane_id: 'pane-1', request_id: 'req-7', decision: 'yes', reason: '' },
    ]);
    // Answered once: the dialog closes so a second tap cannot double-answer.
    expect(useStore.getState().pendingApproval).toBeNull();
    expect(useStore.getState().mode).toBe('normal');
  });

  it('rejects with a tap', () => {
    const send = pendingOnPhone();
    render(<MobileApp />);

    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));

    expect(approvalSent(send)).toEqual([
      { pane_id: 'pane-1', request_id: 'req-7', decision: 'no', reason: '' },
    ]);
  });

  it('offers approve-always by tap, the way the y/Y keys do', () => {
    const send = pendingOnPhone();
    render(<MobileApp />);

    fireEvent.click(screen.getByRole('button', { name: /always/i }));

    expect(approvalSent(send)[0]).toMatchObject({ decision: 'yes_always' });
  });

  it('rejects with a typed reason — no Enter key required', () => {
    const send = pendingOnPhone();
    render(<MobileApp />);

    fireEvent.click(screen.getByRole('button', { name: /reason/i }));
    const input = screen.getByPlaceholderText(/reason/i);
    fireEvent.change(input, { target: { value: 'that deletes the build' } });
    // A phone keyboard's return key is not guaranteed to submit, so the send
    // must be its own tap target.
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(approvalSent(send)).toEqual([
      {
        pane_id: 'pane-1',
        request_id: 'req-7',
        decision: 'no_with_explanation',
        reason: 'that deletes the build',
      },
    ]);
  });

  it('says so when the server refuses the answer', () => {
    pendingOnPhone(null);
    act(() => {
      useStore.setState({
        approvalError: 'unknown approval decision "approve"',
      });
    });
    render(<MobileApp />);

    // submitApproval closes the dialog optimistically, so a refusal that only
    // went to a console would leave the phone showing "answered" for a tool
    // that is still blocked. It has to appear on the phone itself.
    expect(screen.getByText(/unknown approval decision/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(useStore.getState().approvalError).toBeNull();
  });

  it('sends a choice by tapping it', () => {
    const send = pendingOnPhone({
      ...APPROVAL,
      request: {
        ...APPROVAL.request,
        choices: [
          { label: 'keep going', description: '' },
          { label: 'stop here', description: '' },
        ],
      },
    });
    render(<MobileApp />);

    fireEvent.click(screen.getByText('stop here'));

    expect(approvalSent(send)).toEqual([
      { pane_id: 'pane-1', request_id: 'req-7', decision: 'choice_selected', reason: '1' },
    ]);
  });
});
