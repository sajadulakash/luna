import type { Meeting } from '../../api/types';
import { formatTimeRange } from '../../lib/datetime';

/**
 * A meeting as it sits on the calendar.
 *
 * Position and height are handed in by DayColumn — this component never works
 * out where anything belongs in time.
 */

interface MeetingCardProps {
  meeting: Meeting;
  /** Offset from the top of the day column, in pixels. */
  top: number;
  height: number;
  onSelect: (meeting: Meeting) => void;
  /**
   * Blocked time — lunch, a holiday, a focus block — drawn hatched in --faint.
   *
   * Nothing sets this yet: §5 has no field distinguishing a block from a
   * meeting, and guessing from the title or from `booked_via` would be the
   * frontend inventing scheduling semantics. Raised with the backend team;
   * the styling is here so wiring it up is a one-line change.
   */
  blocked?: boolean;
}

export function MeetingCard({
  meeting,
  top,
  height,
  onSelect,
  blocked = false,
}: MeetingCardProps) {
  const cancelled = meeting.status === 'CANCELLED';

  return (
    <button
      type="button"
      onClick={() => onSelect(meeting)}
      style={{ top, height: Math.max(height, 22) }}
      className={[
        'absolute left-px right-px overflow-hidden rounded-control px-8 py-4 text-left',
        'transition-colors duration-150 ease-out',
        'focus-visible:z-10',
        blocked ? 'hatched border border-line' : 'bg-accent-soft',
        cancelled ? 'opacity-50 line-through' : '',
      ].join(' ')}
      aria-label={`${meeting.title}, ${formatTimeRange(meeting.start_at, meeting.end_at)}`}
    >
      <span className="block truncate text-12 font-medium text-ink">
        {meeting.title}
      </span>
      {height >= 44 ? (
        <span className="tnum block truncate font-mono text-12 text-muted">
          {formatTimeRange(meeting.start_at, meeting.end_at)}
        </span>
      ) : null}
    </button>
  );
}
