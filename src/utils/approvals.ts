import { useStore } from '../store';
import { sendCommand } from './commands';

// Answering a gated tool — the ONE path, shared by every surface.
//
// A tool call that needs approval blocks in the orchestrator
// (rysh-shared/agentic/orchestrator.go waitForApproval) until a decision is
// published to `pane.<id>.approval.response`. The `approval_response` ws command
// (rysh-cli/internal/web/server.go) publishes exactly that subject, so any
// client that sends it releases the waiting tool — desktop keyboard, mouse, or
// phone tap alike.
//
// This lives outside the components on purpose: the answer used to exist twice,
// once in useKeyboard's y/Y/n/N handler and once inline in ApprovalOverlay's
// choice list, and a second copy is how one surface quietly stops clearing the
// dialog or starts sending a decision string the server does not know.

/** The decisions the server understands (rysh-shared/msg: ApprovalDecision). */
export type ApprovalDecision =
  | 'yes'
  | 'yes_always'
  | 'no'
  | 'no_with_explanation'
  | 'choice_selected';

/**
 * Answer the pending approval, then close the dialog. No-op when nothing is
 * waiting, so a double-tap (or a key racing a tap) cannot answer twice — the
 * second call finds pendingApproval already null.
 *
 * choiceIdx goes with 'choice_selected' only: the zero-based index into the
 * request's choices, which the ask_user tool turns into the option text (F-47).
 * Pass the option's label as reason, for the pane echo.
 */
export function submitApproval(
  decision: ApprovalDecision,
  reason?: string,
  choiceIdx?: number,
): void {
  const store = useStore.getState();
  if (!store.pendingApproval) return;
  sendCommand('approval_response', {
    pane_id: store.pendingApproval.pane_id,
    request_id: store.pendingApproval.request.request_id,
    decision,
    reason: reason || '',
    ...(decision === 'choice_selected' ? { choice_idx: choiceIdx ?? 0 } : {}),
  });
  store.setPendingApproval(null);
  store.setMode('normal');
}
