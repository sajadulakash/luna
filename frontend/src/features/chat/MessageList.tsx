import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import type { ChatMessage, Slot } from '../../api/types';
import { formatDayDivider, isNewDay } from '../../lib/datetime';
import type { Draft } from './useChatSession';
import { MessageBubble } from './MessageBubble';
import { SlotCards } from './SlotCards';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ConflictLine } from './ConflictLine';

/**
 * Scroll management: autoscroll unless the reader has scrolled up.
 *
 * Sticking to the bottom during a stream is right until someone scrolls back
 * to reread something, at which point yanking them down again is hostile. So
 * "near the bottom" is tracked, and a jump-to-latest button appears when it
 * isn't true.
 */

/** How close to the bottom still counts as "following along". */
const STICK_THRESHOLD_PX = 64;

interface MessageListProps {
  messages: ChatMessage[];
  draft: Draft | null;
  streaming: boolean;
  onChooseSlot?: (slot: Slot) => void;
  error: string | null;
  onRetry: () => void;
}

export function MessageList({
  messages,
  draft,
  streaming,
  onChooseSlot,
  error,
  onRetry,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance <= STICK_THRESHOLD_PX);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  // Layout effect so the jump happens in the same frame the token lands —
  // otherwise a fast stream visibly shudders.
  useLayoutEffect(() => {
    if (atBottom) scrollToBottom('auto');
  }, [atBottom, messages, draft, scrollToBottom]);

  useEffect(() => {
    scrollToBottom('auto');
    // Once, on mount, to open at the newest message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showThinking = streaming && (!draft || draft.content.length === 0);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scroll-touch h-full overflow-y-auto overscroll-contain px-16 py-16"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
      >
        <div className="mx-auto flex max-w-chat flex-col gap-16">
          {messages.map((message, index) => {
            const previous = index > 0 ? messages[index - 1]!.created_at : null;
            const startsDay = isNewDay(message.created_at, previous);

            return (
              // Keyed by position as well as id: ids are unique per
              // conversation in the real API, but the list is append-only
              // and this keeps rendering stable if one ever repeats.
              <div key={`${message.id}-${index}`} className="flex flex-col gap-16">
                {startsDay && index > 0 ? (
                  <DayDivider iso={message.created_at} />
                ) : null}

                <div className="flex flex-col">
                  {message.conflict ? <ConflictLine reason={message.conflict} /> : null}

                  <MessageBubble message={message} showTimestamp={startsDay} />

                  {message.slots?.length ? (
                    <div className="mt-4 max-w-[85%]">
                      <SlotCards
                        slots={message.slots}
                        onChoose={onChooseSlot}
                        disabled={streaming}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}

          {draft ? (
            <div className="flex flex-col">
              {draft.conflict ? <ConflictLine reason={draft.conflict} /> : null}

              {draft.content ? (
                <div className="flex items-start">
                  <div className="max-w-[85%] rounded-card bg-accent-soft px-16 py-12 text-17 text-ink">
                    <span className="whitespace-pre-wrap break-words">
                      {draft.content}
                    </span>
                  </div>
                </div>
              ) : null}

              {draft.slots?.length ? (
                <div className="mt-4 max-w-[85%]">
                  <SlotCards slots={draft.slots} onChoose={onChooseSlot} disabled />
                </div>
              ) : null}
            </div>
          ) : null}

          {showThinking ? <ThinkingIndicator tool={draft?.tool} /> : null}

          {error ? <StreamError message={error} onRetry={onRetry} /> : null}

          <div ref={bottomRef} className="h-px" />
        </div>
      </div>

      {!atBottom ? (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          aria-label="Jump to latest message"
          className={[
            'tap absolute bottom-16 left-1/2 -translate-x-1/2',
            'flex items-center justify-center rounded-pill',
            'border border-line bg-surface px-16 text-13 text-muted',
            'motion-safe:animate-luna-rise',
          ].join(' ')}
        >
          <ArrowDown size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function DayDivider({ iso }: { iso: string }) {
  return (
    <div className="flex items-center gap-12 py-4">
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      <span className="text-12 text-faint">{formatDayDivider(iso)}</span>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </div>
  );
}

/**
 * A stream that died. Recoverable — what already arrived stays on screen and
 * the last message can be sent again.
 */
function StreamError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-8">
      <p className="text-15 text-busy">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="tap rounded-control border border-line bg-surface px-16 text-15 text-ink transition-colors duration-150 ease-out hover:border-accent"
      >
        Try again
      </button>
    </div>
  );
}
