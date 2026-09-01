import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from 'react';
import type { Slot } from '../../api/types';
import { useChatSession } from './useChatSession';
import { MessageList } from './MessageList';
import { Composer } from './Composer';

/**
 * The conversation, shared by both routes.
 *
 * The differences between employee and owner chat are props — available
 * greeting, whether slot cards can be tapped, what sits beside the composer —
 * not two components.
 */

export interface ChatPaneHandle {
  /** Sends a message from outside, as if it had been typed. */
  send: (text: string) => void;
  /** Shows a turn that has already happened — voice mode's transcript. */
  appendMessage: (role: 'user' | 'assistant', content: string) => void;
}

export interface ChatPaneProps {
  /** Employee: the token from the URL. Owner: the in-memory access token. */
  token: string | null;
  /** Luna's opening line when the conversation is empty. */
  greeting?: string;
  header?: ReactNode;
  /** Employee chat taps slots to choose. The owner console reads them. */
  slotsTappable?: boolean;
  /** Sits to the left of the composer — the mic orb on the owner console. */
  composerLeading?: ReactNode;
  /** Live voice transcript, shown greyed in the composer. */
  interim?: string;
  composerPlaceholder?: string;
  /** The final assistant text, for TTS. */
  onAssistantMessage?: (text: string) => void;
  /** Whether a reply is currently streaming — drives the orb and the mic. */
  onStreamingChange?: (streaming: boolean) => void;
  /** Shown instead of the conversation when the API rejects the token. */
  renderDeadLink?: () => ReactNode;
  autoFocusComposer?: boolean;
}

export const ChatPane = forwardRef<ChatPaneHandle, ChatPaneProps>(function ChatPane(
  {
    token,
    greeting,
    header,
    slotsTappable = false,
    composerLeading,
    interim = '',
    composerPlaceholder,
    onAssistantMessage,
    onStreamingChange,
    renderDeadLink,
    autoFocusComposer = false,
  },
  ref,
) {
  const session = useChatSession({ token, greeting, onAssistantMessage });

  useImperativeHandle(
    ref,
    () => ({ send: session.send, appendMessage: session.appendMessage }),
    [session.appendMessage, session.send],
  );

  useStreamingReporter(session.streaming, onStreamingChange);

  if (session.historyState === 'dead-link' && renderDeadLink) {
    return <>{renderDeadLink()}</>;
  }

  const chooseSlot = slotsTappable
    ? (slot: Slot) => session.send(slot.label)
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {header}

      <MessageList
        messages={session.messages}
        draft={session.draft}
        streaming={session.streaming}
        onChooseSlot={chooseSlot}
        error={session.error}
        onRetry={session.retry}
      />

      <Composer
        onSend={session.send}
        disabled={session.streaming}
        interim={interim}
        leading={composerLeading}
        placeholder={composerPlaceholder}
        autoFocus={autoFocusComposer}
      />
    </div>
  );
});

/** Fires `onStreamingChange` when the flag actually flips, and only then. */
function useStreamingReporter(
  streaming: boolean,
  onStreamingChange?: (streaming: boolean) => void,
): void {
  const previous = useRef(streaming);
  const callbackRef = useRef(onStreamingChange);
  callbackRef.current = onStreamingChange;

  useEffect(() => {
    if (previous.current === streaming) return;
    previous.current = streaming;
    callbackRef.current?.(streaming);
  }, [streaming]);
}
