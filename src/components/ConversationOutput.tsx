import React, { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useStore } from '../store';
import { ansiToHtml } from '../utils/ansi';
import type { ConversationMessage } from '../types';

interface Props {
  paneId: string;
  messages: ConversationMessage[];
  conversationType?: string;
}

// --- Utilities ---

export function formatRelativeTime(timestampMs: number): string {
  const now = Date.now();
  const diff = now - timestampMs;

  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// --- Style Configs ---

const SOURCE_STYLES: Record<string, { bg: string; text: string; align: string; prefix?: string }> = {
  human:    { bg: 'bg-[#1a3a5f]', text: 'text-[#87d7ff]', align: 'right' },
  ai:       { bg: 'bg-[#1a2a1a]', text: 'text-[#87ff87]', align: 'left', prefix: 'AI' },
  agent:    { bg: 'bg-[#2a1a2a]', text: 'text-[#d787ff]', align: 'left' },
  subagent: { bg: 'bg-[#2a1a2a]', text: 'text-[#d787ff]', align: 'left' },
  humanoid: { bg: 'bg-[#1a2a2a]', text: 'text-[#87ffff]', align: 'left' },
  system:   { bg: 'bg-[#333]',    text: 'text-[#808080]', align: 'center' },
  external: { bg: 'bg-[#2a2a1a]', text: 'text-[#ffff87]', align: 'left' },
};

const CONVERSATION_TYPE_COLORS: Record<string, string> = {
  shell:   '#5fafff',
  ai:      '#87ff87',
  rysh:    '#5fafff',
  chat:    '#ffff87',
  email:   '#d787ff',
  slack:   '#ff87d7',
  chatbot: '#87d7ff',
};

const MAX_DISPLAYED_MESSAGES = 500;

// --- Sub-components ---

const ConversationTypeBadge = React.memo(function ConversationTypeBadge({ type }: { type: string }) {
  const color = CONVERSATION_TYPE_COLORS[type] || '#aaaaaa';
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-bold uppercase leading-none"
      style={{ color, border: `1px solid ${color}40`, backgroundColor: `${color}15` }}
    >
      {type}
    </span>
  );
});

const SensitiveContent = React.memo(function SensitiveContent({ html }: { html: string }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="relative">
      <div
        className={revealed ? '' : 'blur-sm select-none cursor-pointer'}
        onClick={() => setRevealed(true)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {!revealed && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs text-[#808080] bg-[#1e1e1e] px-2 py-1 rounded border border-[#444] cursor-pointer"
            onClick={() => setRevealed(true)}
          >
            click to reveal
          </span>
        </div>
      )}
    </div>
  );
});

const StreamingCursor = React.memo(function StreamingCursor() {
  return (
    <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse rounded-sm opacity-70" />
  );
});

const MessageBubble = React.memo(function MessageBubble({ message }: { message: ConversationMessage }) {
  const style = SOURCE_STYLES[message.message_source] || SOURCE_STYLES.external;
  const contentHtml = useMemo(() => ansiToHtml(message.content), [message.content]);
  const relativeTime = formatRelativeTime(message.timestamp_ms);

  const isSystem = message.message_source === 'system';
  const isRight = style.align === 'right';
  const isCenter = style.align === 'center';

  let containerAlign = 'justify-start';
  if (isRight) containerAlign = 'justify-end';
  if (isCenter) containerAlign = 'justify-center';

  let sourceLabel = '';
  if (style.prefix) {
    sourceLabel = style.prefix;
  } else if (message.message_source === 'agent' || message.message_source === 'subagent') {
    sourceLabel = 'agent';
  } else if (message.message_source === 'humanoid') {
    sourceLabel = 'humanoid';
  } else if (message.message_source === 'external') {
    sourceLabel = 'external';
  }

  return (
    <div className={`flex ${containerAlign} mb-2`}>
      <div
        className={`
          ${style.bg} ${style.text} rounded-lg px-3 py-2
          ${isSystem ? 'italic text-xs max-w-[90%]' : 'max-w-[80%]'}
          font-mono text-sm leading-relaxed whitespace-pre-wrap break-words
        `}
      >
        <div className="flex items-center gap-2 mb-1 text-[10px] opacity-70">
          {sourceLabel && (
            <span className="font-bold uppercase">{sourceLabel}</span>
          )}
          <ConversationTypeBadge type={message.conversation_type} />
          <span className="ml-auto">{relativeTime}</span>
        </div>

        {message.sensitive ? (
          <SensitiveContent html={contentHtml} />
        ) : (
          <div dangerouslySetInnerHTML={{ __html: contentHtml }} />
        )}

        {message.streaming && <StreamingCursor />}
      </div>
    </div>
  );
});

// --- Main Component ---

export const ConversationOutput = React.memo(function ConversationOutput({
  paneId,
  messages,
  conversationType,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollLocked = useStore((s) => s.paneScrollLocked[paneId]);
  const setPaneScrollLocked = useStore((s) => s.setPaneScrollLocked);

  // Live scroll-lock value, updated SYNCHRONOUSLY on user scroll intent. The
  // store copy drives the indicator, but store→render propagation is async:
  // during streaming, the auto-scroll rAF below read the stale rendered value
  // and snapped back to the bottom, eating the user's scroll-up ("cannot
  // scroll up while messages stream"). The render assignment re-syncs the ref
  // when the store changes from the outside (keyboard shortcuts).
  const scrollLockedRef = useRef(!!scrollLocked);
  scrollLockedRef.current = !!scrollLocked;
  const setLock = useCallback(
    (locked: boolean) => {
      scrollLockedRef.current = locked;
      setPaneScrollLocked(paneId, locked);
    },
    [paneId, setPaneScrollLocked]
  );

  const filteredMessages = useMemo(() => {
    let msgs = messages;
    if (conversationType) {
      msgs = msgs.filter((m) => m.conversation_type === conversationType);
    }
    if (msgs.length > MAX_DISPLAYED_MESSAGES) {
      msgs = msgs.slice(msgs.length - MAX_DISPLAYED_MESSAGES);
    }
    return msgs;
  }, [messages, conversationType]);

  useEffect(() => {
    if (scrollLocked) return;
    requestAnimationFrame(() => {
      // Re-check at execution time: the user may have scrolled up between the
      // message update that scheduled this snap and the frame it runs in.
      if (scrollLockedRef.current) return;
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    });
  }, [filteredMessages, scrollLocked]);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 10;
    setLock(!atBottom);
  }, [setLock]);

  // Engage the lock on the wheel-up GESTURE itself, before the browser even
  // updates scrollTop / fires a scroll event — otherwise a pending snap lands
  // in between and the view jumps straight back to the bottom.
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.deltaY < 0 && el.scrollHeight > el.clientHeight) setLock(true);
    },
    [setLock]
  );

  if (filteredMessages.length === 0) {
    return (
      <div
        ref={ref}
        className="pane-output flex items-center justify-center"
      >
        <span className="text-[#555] text-sm italic font-mono">No messages yet</span>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      id={'output-' + paneId}
      className="pane-output"
      onScroll={handleScroll}
      onWheel={handleWheel}
      style={{ padding: '8px' }}
    >
      {filteredMessages.map((msg) => (
        <MessageBubble key={msg.turn_id} message={msg} />
      ))}

      {scrollLocked && (
        <div className="sticky bottom-0 left-0 right-0 flex justify-center pointer-events-none">
          <span className="bg-[#333] text-[#888] text-[10px] px-2 py-0.5 rounded-t font-mono pointer-events-auto cursor-pointer"
            onClick={() => {
              setLock(false);
              if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
            }}
          >
            scroll locked - click to resume
          </span>
        </div>
      )}
    </div>
  );
});
