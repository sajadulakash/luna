import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';

/**
 * The composer.
 *
 * Grows to five lines then scrolls. Disabled while streaming.
 *
 * Enter-to-send is a desktop convention: on a phone the Return key is how you
 * make a new line and there is no Shift to hold, so Enter only sends where a
 * fine pointer exists. The send button is always present — it is the primary
 * control on touch.
 */

const MAX_LINES = 5;

interface ComposerProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /**
   * The live, uncommitted voice transcript. Shown greyed behind the field so
   * it is visibly hearing you; it commits to a real message on send.
   */
  interim?: string;
  /** Rendered to the left of the field — the mic orb on the owner console. */
  leading?: React.ReactNode;
  autoFocus?: boolean;
}

export function Composer({
  onSend,
  disabled = false,
  placeholder = 'Message Luna',
  interim = '',
  leading,
  autoFocus = false,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [enterSends, setEnterSends] = useState(false);

  useEffect(() => {
    // A mouse or trackpad means a real keyboard is likely present.
    setEnterSends(window.matchMedia('(pointer: fine)').matches);
  }, []);

  // Auto-grow. Reset to auto first so the box can shrink again on delete.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = 'auto';

    const styles = window.getComputedStyle(el);
    const lineHeight = parseFloat(styles.lineHeight) || 26;
    const padding =
      parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom) || 0;
    const max = lineHeight * MAX_LINES + padding;

    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value, interim]);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
  }, [disabled, onSend, value]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter') return;
      if (!enterSends) return;
      // Shift+Enter newlines. So does an IME composition still in progress.
      if (event.shiftKey || event.nativeEvent.isComposing) return;

      event.preventDefault();
      submit();
    },
    [enterSends, submit],
  );

  const canSend = value.trim().length > 0 && !disabled;
  // While the mic is hearing something, the field shows that instead.
  const showInterim = interim.length > 0 && value.length === 0;

  return (
    <div className="border-t border-line bg-surface px-16 pb-safe pt-12">
      <div className="mx-auto flex max-w-chat items-end gap-8 pb-12">
        {leading}

        <div className="relative min-w-0 flex-1">
          {showInterim ? (
            <p
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden rounded-control px-12 py-8 text-17 text-faint"
            >
              {interim}
            </p>
          ) : null}

          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            autoFocus={autoFocus}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={showInterim ? '' : placeholder}
            aria-label="Message Luna"
            className={[
              'block w-full resize-none rounded-control border border-line bg-bg',
              'px-12 py-8 text-17 text-ink placeholder:text-faint',
              'transition-colors duration-150 ease-out',
              'focus:border-accent',
              disabled ? 'cursor-not-allowed opacity-60' : '',
            ].join(' ')}
          />
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send message"
          className={[
            'tap flex shrink-0 items-center justify-center rounded-pill',
            'transition-colors duration-150 ease-out',
            canSend
              ? 'bg-accent text-surface'
              : 'bg-surface-2 text-faint cursor-not-allowed',
          ].join(' ')}
        >
          <ArrowUp size={20} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
