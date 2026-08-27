import type { DateTime } from 'luxon';
import type { Meeting } from '../../api/types';
import { isToday, minutesFromMidnight, nowMinutes, spanMinutes } from '../../lib/datetime';
import { MeetingCard } from './MeetingCard';
import { PLACEHOLDER_WORKING_HOURS, PX_PER_MINUTE } from './constants';

/**
 * One day of the week.
 *
 * Meetings are positioned from the timestamps the API sent, converted to the
 * viewer's zone. Nothing here decides whether two meetings overlap or where a
 * gap is — they are drawn where they fall.
 */

interface DayColumnProps {
  day: DateTime;
  /** Already filtered to this day by WeekView, in the order the API sent. */
  meetings: Meeting[];
  firstHour: number;
  lastHour: number;
  onSelect: (meeting: Meeting) => void;
  zone: string;
}

export function DayColumn({
  day,
  meetings,
  firstHour,
  lastHour,
  onSelect,
  zone,
}: DayColumnProps) {
  const topMinutes = firstHour * 60;
  const heightPx = (lastHour - firstHour) * 60 * PX_PER_MINUTE;
  const today = isToday(day, zone);
  const currentMinutes = today ? nowMinutes(zone) : null;

  const workStart = (PLACEHOLDER_WORKING_HOURS.start - firstHour) * 60 * PX_PER_MINUTE;
  const workEnd = (PLACEHOLDER_WORKING_HOURS.end - firstHour) * 60 * PX_PER_MINUTE;

  return (
    <div
      className="relative min-w-[96px] flex-1 border-l border-line bg-bg"
      style={{ height: heightPx }}
    >
      {/* Working hours sit on --surface; the rest of the day stays on --bg. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bg-surface"
        style={{ top: Math.max(workStart, 0), height: Math.max(workEnd - workStart, 0) }}
      />

      {/* Hour lines. */}
      {Array.from({ length: lastHour - firstHour + 1 }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="absolute inset-x-0 h-px bg-line"
          style={{ top: i * 60 * PX_PER_MINUTE }}
        />
      ))}

      {meetings.map((meeting) => {
        const start = minutesFromMidnight(meeting.start_at, zone) - topMinutes;
        const span = spanMinutes(meeting.start_at, meeting.end_at);

        return (
          <MeetingCard
            key={meeting.id}
            meeting={meeting}
            top={start * PX_PER_MINUTE}
            height={span * PX_PER_MINUTE}
            onSelect={onSelect}
          />
        );
      })}

      {currentMinutes !== null ? (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 z-10 h-px bg-busy"
          style={{ top: (currentMinutes - topMinutes) * PX_PER_MINUTE }}
        />
      ) : null}
    </div>
  );
}
