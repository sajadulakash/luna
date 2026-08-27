import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchChatHistory, streamChat, type ChatStreamEvent } from '../../api/chat';
import { ApiRequestError } from '../../api/client';
import { queryKeys } from '../../api/meetings';
import type { ChatMessage, ConflictReason, Slot } from '../../api/types';

/**
 * The conversation.
 *
 * Built around streaming from the outset: there is a settled list of messages
 * and, while a reply is arriving, a separate draft that accumulates tokens.
 * The two are rendered the same way, so nothing needs rewriting to make
 * streaming work — it is how the component already thinks.
 */

/** The reply currently arriving, token by token. */
export interface Draft {
  content: string;
  slots?: Slot[];
  conflict?: ConflictReason;
  /** The tool Luna is using right now, for the "checking the calendar…" line. */
  tool: string | null;
}

export interface ChatSessionOptions {
  token: string | null;
  /** Luna's opening line. Local only — never posted to the API. */
  greeting?: string;
  /** Called with the final assistant text, for the owner's TTS. */
  onAssistantMessage?: (text: string) => void;
}

const GREETING_ID = 'local-greeting';

export function useChatSession({
  token,
  greeting,
  onAssistantMessage,
}: ChatSessionOptions) {
  const queryClient = useQueryClient();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'dead-link'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const localIdRef = useRef(0);
  /** The last thing the user said, so a failed turn can be retried. */
  const lastSentRef = useRef<string | null>(null);

  const onAssistantMessageRef = useRef(onAssistantMessage);
  onAssistantMessageRef.current = onAssistantMessage;

  const nextLocalId = useCallback(() => {
    localIdRef.current += 1;
    return `local-${localIdRef.current}`;
  }, []);

  const greetingMessage = useMemo<ChatMessage | null>(
    () =>
      greeting
        ? {
            id: GREETING_ID,
            role: 'assistant',
            content: greeting,
            created_at: new Date().toISOString(),
          }
        : null,
    [greeting],
  );

  // --- History ---------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    setHistoryState('loading');

    fetchChatHistory(token)
      .then((history) => {
        if (cancelled) return;
        // Already ordered by the API. Not re-sorted here.
        setMessages(history);
        setHistoryState('ready');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiRequestError && cause.isDeadLink) {
          setHistoryState('dead-link');
          return;
        }
        // A failed history load is not fatal — the conversation can still start.
        setMessages([]);
        setHistoryState('ready');
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  // --- Sending ---------------------------------------------------------------

  const runStream = useCallback(
    (text: string) => {
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;

      setStreaming(true);
      setError(null);
      setDraft({ content: '', tool: null });

      const handle = (event: ChatStreamEvent) => {
        switch (event.type) {
          case 'token':
            setDraft((prev) =>
              prev ? { ...prev, content: prev.content + event.text, tool: null } : prev,
            );
            break;

          case 'tool_start':
            setDraft((prev) => (prev ? { ...prev, tool: event.name } : prev));
            break;

          case 'tool_end':
            setDraft((prev) => (prev ? { ...prev, tool: null } : prev));
            break;

          case 'slots':
            setDraft((prev) => (prev ? { ...prev, slots: event.slots } : prev));
            break;

          case 'conflict':
            setDraft((prev) => (prev ? { ...prev, conflict: event.reason } : prev));
            break;

          case 'draft_reset':
            // What streamed before a tool ran was preamble. The answer that
            // replaces it is on its way, so clear the text but keep any slots
            // or conflict already attached to this reply.
            setDraft((prev) => (prev ? { ...prev, content: '' } : prev));
            break;

          case 'meetings_changed':
            // Luna booked something. The calendar moves without a reload.
            void queryClient.invalidateQueries({ queryKey: queryKeys.allMeetings });
            break;

          case 'message':
            // The authoritative final object. Replace the accumulated draft
            // with it rather than trusting our own concatenation.
            setMessages((prev) => [...prev, event.message]);
            setDraft(null);
            onAssistantMessageRef.current?.(event.message.content);
            break;

          case 'error':
            setError(event.message);
            break;

          case 'done':
            setStreaming(false);
            break;
        }
      };

      streamChat({ message: text, token, onEvent: handle, signal: controller.signal })
        .catch((cause: unknown) => {
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          if (cause instanceof ApiRequestError && cause.isDeadLink) {
            setHistoryState('dead-link');
            return;
          }
          setError(
            cause instanceof Error
              ? cause.message
              : 'The connection dropped before I finished.',
          );
        })
        .finally(() => {
          if (controller.signal.aborted) return;
          setStreaming(false);
          // Whatever arrived before the stream died stays on screen as a
          // message, so a mid-stream failure is recoverable rather than blank.
          setDraft((prev) => {
            if (!prev) return null;
            if (!prev.content && !prev.slots && !prev.conflict) return null;
            setMessages((msgs) => [
              ...msgs,
              {
                id: nextLocalId(),
                role: 'assistant',
                content: prev.content,
                created_at: new Date().toISOString(),
                slots: prev.slots,
                conflict: prev.conflict,
              },
            ]);
            return null;
          });
        });
    },
    [nextLocalId, queryClient, token],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      lastSentRef.current = trimmed;

      setMessages((prev) => [
        ...prev,
        {
          id: nextLocalId(),
          role: 'user',
          content: trimmed,
          created_at: new Date().toISOString(),
        },
      ]);

      runStream(trimmed);
    },
    [nextLocalId, runStream, streaming],
  );

  const retry = useCallback(() => {
    const last = lastSentRef.current;
    if (!last || streaming) return;
    runStream(last);
  }, [runStream, streaming]);

  // An orphaned stream keeps writing into a dead component.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const visibleMessages = useMemo(() => {
    if (!greetingMessage) return messages;
    // The greeting only stands in for an empty conversation.
    return messages.length === 0 ? [greetingMessage] : messages;
  }, [greetingMessage, messages]);

  return {
    messages: visibleMessages,
    draft,
    streaming,
    error,
    historyState,
    send,
    retry,
    dismissError: useCallback(() => setError(null), []),
  };
}
