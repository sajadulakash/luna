import { API_BASE_URL } from '../lib/env';
import { consumeSseStream } from '../lib/sse';
import { apiFetch, ApiRequestError, NetworkError } from './client';
import type { ChatMessage, ConflictReason, Slot } from './types';

/**
 * Chat streaming (§8).
 *
 * The wire protocol is a fixed set of named events. Rather than hand every
 * consumer an untyped payload, the raw frames are narrowed into this union
 * here — so `src/api` stays free of `any` and a component switching on
 * `event.type` gets exhaustiveness checking.
 */
export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string; ok: boolean }
  | { type: 'slots'; slots: Slot[] }
  | { type: 'conflict'; reason: ConflictReason }
  | { type: 'meetings_changed' }
  | { type: 'message'; message: ChatMessage }
  | { type: 'error'; error: string; message: string }
  | { type: 'done' };

function asRecord(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * Maps one wire frame onto the union.
 *
 * Unknown event names and frames missing their required field return null and
 * are dropped. The backend adding an event we don't handle yet must not break
 * a running conversation.
 */
export function toChatEvent(event: string, data: unknown): ChatStreamEvent | null {
  const d = asRecord(data);

  switch (event) {
    case 'token':
      return typeof d.text === 'string' ? { type: 'token', text: d.text } : null;

    case 'tool_start':
      return typeof d.name === 'string' ? { type: 'tool_start', name: d.name } : null;

    case 'tool_end':
      return typeof d.name === 'string'
        ? { type: 'tool_end', name: d.name, ok: d.ok !== false }
        : null;

    case 'slots':
      return Array.isArray(d.slots) ? { type: 'slots', slots: d.slots as Slot[] } : null;

    case 'conflict':
      return typeof d.reason === 'string'
        ? { type: 'conflict', reason: d.reason as ConflictReason }
        : null;

    case 'meetings_changed':
      return { type: 'meetings_changed' };

    case 'message':
      return typeof d.id === 'string'
        ? { type: 'message', message: data as ChatMessage }
        : null;

    case 'error':
      return {
        type: 'error',
        error: typeof d.error === 'string' ? d.error : 'unknown_error',
        message:
          typeof d.message === 'string'
            ? d.message
            : 'Something went wrong on my end.',
      };

    case 'done':
      return { type: 'done' };

    default:
      return null;
  }
}

export interface StreamChatOptions {
  message: string;
  token: string | null;
  onEvent: (event: ChatStreamEvent) => void;
  signal?: AbortSignal;
}

/**
 * POSTs a message and streams the reply.
 *
 * Always pass an AbortSignal and abort on unmount — an orphaned stream keeps
 * writing into a dead component.
 */
export async function streamChat({
  message,
  token,
  onEvent,
  signal,
}: StreamChatOptions): Promise<void> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message }),
      credentials: 'include',
      signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError("I couldn't reach the server.");
  }

  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      res.status === 401 || res.status === 403 ? 'invalid_token' : 'chat_failed',
      `Chat failed (${res.status}).`,
    );
  }

  if (!res.body) {
    throw new NetworkError('The reply stream was empty.');
  }

  await consumeSseStream(res.body, (name, data) => {
    const parsed = toChatEvent(name, data);
    if (parsed) onEvent(parsed);
  });
}

export function fetchChatHistory(token: string | null): Promise<ChatMessage[]> {
  return apiFetch<ChatMessage[]>('/api/chat/history', { token });
}
