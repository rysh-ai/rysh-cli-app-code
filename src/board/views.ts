import type { BoardThread } from '../types';

// Board views (design 051), a port of rysh-cli internal/board/views.go.
//
// STATUS is what an agent says about itself; PROMPT is what one agent tells
// another to do — a `cmd` and the thread it opens (ack, replies, undelivered
// notices). The unit is the THREAD: an ack without its order, or an order
// without its ack, is half a conversation. FLOW (design 052) and TEAM (design
// 054 §8b) are not filters but different renderings of the whole board.

export type BoardView = 'status' | 'prompt' | 'all' | 'flow' | 'team';

/** What a board pane opens on, as in the terminal. */
export const DEFAULT_BOARD_VIEW: BoardView = 'status';

/** A thread whose root is a command; a provisional one is judged by what it holds. */
export function isPromptThread(t: BoardThread): boolean {
  if (t.root) return t.root.kind === 'cmd';
  return (t.replies || []).some((r) => r && (r.kind === 'cmd' || r.kind === 'ack'));
}

export function filterThreads(ts: BoardThread[], v: BoardView): BoardThread[] {
  if (v === 'status') return ts.filter((t) => !isPromptThread(t));
  if (v === 'prompt') return ts.filter(isPromptThread);
  return ts;
}

export function countViews(ts: BoardThread[]): { status: number; prompt: number } {
  let prompt = 0;
  for (const t of ts) if (isPromptThread(t)) prompt++;
  return { status: ts.length - prompt, prompt };
}
