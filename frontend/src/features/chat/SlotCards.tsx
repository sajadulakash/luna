import type { Slot } from '../../api/types';
import { formatDuration } from '../../lib/datetime';

/**
 * The tappable time suggestions.
 *
 * `label` is used as-is: the backend renders the human phrasing so the two
 * sides can never disagree about how a time reads. The duration comes from
 * the slot's own start and end — nothing here works out when a slot ends.
 *
 * Three maximum; the API won't send more.
 */

interface SlotCardsProps {
  slots: Slot[];
  /** Employee chat taps to choose. Read-only elsewhere. */
  onChoose?: (slot: Slot) => void;
  disabled?: boolean;
}

export function SlotCards({ slots, onChoose, disabled = false }: SlotCardsProps) {
  if (slots.length === 0) return null;

  const tappable = Boolean(onChoose);

  return (
    <ul className="mt-8 flex flex-col gap-8" aria-label="Suggested times">
      {slots.map((slot) => {
        const duration = formatDuration(slot.start, slot.end);

        return (
          <li key={`${slot.start}-${slot.end}`}>
            {tappable ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChoose?.(slot)}
                className={[
                  'tap flex w-full items-center justify-between gap-12',
                  'rounded-card border border-line bg-surface px-16 py-12 text-left',
                  'transition-colors duration-150 ease-out',
                  disabled
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:border-accent active:bg-accent-soft',
                ].join(' ')}
              >
                <span className="text-15 font-medium text-ink">{slot.label}</span>
                <span className="tnum shrink-0 font-mono text-13 text-free">
                  {duration}
                </span>
              </button>
            ) : (
              <div className="flex w-full items-center justify-between gap-12 rounded-card border border-line bg-surface px-16 py-12">
                <span className="text-15 font-medium text-ink">{slot.label}</span>
                <span className="tnum shrink-0 font-mono text-13 text-free">
                  {duration}
                </span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
