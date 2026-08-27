import { useState } from 'react';
import type { ChatMessage } from '../../api/types';
import { formatTime } from '../../lib/datetime';

/**
 * One message.
 *
 * Luna is left-aligned on --accent-soft, the person is right-aligned on
 * --surface-2. Chat text is 17px — people read these like messages, not UI.
 *
 * The brief puts timestamps on hover. There is no hover on a phone, so on
 * touch the bubble toggles its timestamp when tapped; on a pointer device the
 * original hover behaviour still applies.
 */

interface MessageBubbleProps {
  message: ChatMessage;
  /** Forces the timestamp on — the first message of a new day. */
  showTimestamp?: boolean;
}

export function MessageBubble({ message, showTimestamp = false }: MessageBubbleProps) {
  const [tapped, setTapped] = useState(false);
  const isLuna = message.role === 'assistant';

  return (
    <div className={`group flex flex-col ${isLuna ? 'items-start' : 'items-end'}`}>
      <button
        type="button"
        onClick={() => setTapped((prev) => !prev)}
        aria-label={`Sent at ${formatTime(message.created_at)}`}
        className={[
          'max-w-[85%] rounded-card px-16 py-12 text-left text-17',
          'transition-colors duration-150 ease-out',
          isLuna ? 'bg-accent-soft text-ink' : 'bg-surface-2 text-ink',
        ].join(' ')}
      >
        <span className="whitespace-pre-wrap break-words">{message.content}</span>
      </button>

      {/* Collapsed to nothing rather than merely transparent when hidden:
          reserving the line would push every bubble apart and detach slot
          cards from the message they belong to. */}
      <time
        dateTime={message.created_at}
        className={[
          'tnum px-4 font-mono text-12 text-faint',
          'overflow-hidden transition-opacity duration-150 ease-out',
          showTimestamp || tapped
            ? 'mt-4 h-16 opacity-100'
            : 'h-0 opacity-0 group-hover:mt-4 group-hover:h-16 group-hover:opacity-100',
        ].join(' ')}
      >
        {formatTime(message.created_at)}
      </time>
    </div>
  );
}
