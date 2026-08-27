import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DateTime } from 'luxon';
import type { Meeting } from '../../api/types';
import { useMeetings } from '../../api/meetings';
import {
  formatHourLabel,
  fromApi,
  isToday,
  viewerZone,
  weekDays,
  weekRange,
} from '../../lib/datetime';
import { DayColumn } from './DayColumn';
import { DEFAULT_FIRST_HOUR, DEFAULT_LAST_HOUR, PX_PER_MINUTE } from './constants';

/**
 * The week.
 *
 * Seven columns with the hours down the side. On a phone the columns would be
 * 50px wide and unreadable, so the grid keeps a minimum column width and
 * scrolls horizontally, with the hour gutter and the day header pinned. At
 * tablet width and up the columns simply share the space.
 */

interface WeekViewProps {
  onSelectMeeting: (meeting: Meeting) => void;
  /** Employee link token. Omitted for the owner calendar. */
  token?: string | null;
}

export function WeekView({ onSelectMeeting, token }: WeekViewProps) {
  const zone = viewerZone();
  const [anchor, setAnchor] = useState(() => DateTime.local().setZone(zone));
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const days = useMemo(() => weekDays(anchor, zone), [anchor, zone]);
  const range = useMemo(() => weekRange(anchor, zone), [anchor, zone]);

  const { data: meetings, isPending, isError } = useMeetings(
    range.from,
    range.to,
    true,
    token,
  );

  // The hour range covers the working day, widened to include anything the
  // API returned outside it — a 7am meeting must not be clipped off the top.
  const { firstHour, lastHour } = useMemo(() => {
    let first = DEFAULT_FIRST_HOUR;
    let last = DEFAULT_LAST_HOUR;

    for (const meeting of meetings ?? []) {
      const start = fromApi(meeting.start_at, zone);
      const end = fromApi(meeting.end_at, zone);
      first = Math.min(first, start.hour);
      last = Math.max(last, end.minute > 0 ? end.hour + 1 : end.hour);
    }

    return { firstHour: Math.max(0, first), lastHour: Math.min(24, Math.max(last, first + 1)) };
  }, [meetings, zone]);

  /** Meetings grouped by day, each group keeping the API's ordering. */
  const byDay = useMemo(() => {
    const groups = new Map<string, Meeting[]>();
    for (const day of days) groups.set(day.toISODate() ?? '', []);

    for (const meeting of meetings ?? []) {
      const key = fromApi(meeting.start_at, zone).toISODate() ?? '';
      groups.get(key)?.push(meeting);
    }

    return groups;
  }, [days, meetings, zone]);

  // Open on the working day rather than at midnight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, (9 - firstHour) * 60 * PX_PER_MINUTE - 24);
  }, [firstHour]);

  const label = `${days[0]!.toFormat('d LLL')} – ${days[6]!.toFormat('d LLL')}`;

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg" aria-label="Calendar">
      <header className="flex items-center justify-between gap-8 border-b border-line bg-surface px-16 py-8">
        <button
          type="button"
          onClick={() => setAnchor((prev) => prev.minus({ weeks: 1 }))}
          aria-label="Previous week"
          className="tap flex items-center justify-center rounded-control text-muted transition-colors duration-150 ease-out hover:text-ink"
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>

        <div className="flex min-w-0 flex-col items-center">
          <span className="tnum truncate font-mono text-13 text-ink">{label}</span>
          <button
            type="button"
            onClick={() => setAnchor(DateTime.local().setZone(zone))}
            className="text-12 text-accent transition-colors duration-150 ease-out"
          >
            Today
          </button>
        </div>

        <button
          type="button"
          onClick={() => setAnchor((prev) => prev.plus({ weeks: 1 }))}
          aria-label="Next week"
          className="tap flex items-center justify-center rounded-control text-muted transition-colors duration-150 ease-out hover:text-ink"
        >
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </header>

      {isError ? (
        <p className="px-16 py-16 text-15 text-busy">
          I couldn&apos;t load the calendar just now.
        </p>
      ) : null}

      <div
        ref={scrollRef}
        className="scroll-touch relative min-h-0 flex-1 overflow-auto overscroll-contain"
      >
        <div className="min-w-max">
          {/* Day header, pinned to the top of the scroller. */}
          <div className="sticky top-0 z-20 flex bg-surface shadow-[0_1px_0_var(--line)]">
            <div className="sticky left-0 z-10 w-48 shrink-0 bg-surface" />
            {days.map((day) => (
              <div
                key={day.toISODate()}
                className="flex min-w-[96px] flex-1 flex-col items-center border-l border-line py-8"
              >
                <span className="text-12 text-muted">{day.toFormat('ccc')}</span>
                <span
                  className={[
                    'tnum font-mono text-15',
                    isToday(day, zone) ? 'text-busy' : 'text-ink',
                  ].join(' ')}
                >
                  {day.toFormat('d')}
                </span>
              </div>
            ))}
          </div>

          {/* pt-12 so the first hour label, which sits above its own
              line, isn't clipped by the top of the scroller. */}
          <div className="flex pt-12">
            {/* Hour gutter, pinned to the left of the scroller. */}
            <div className="sticky left-0 z-10 w-48 shrink-0 bg-bg">
              {Array.from({ length: lastHour - firstHour }, (_, i) => (
                <div
                  key={i}
                  className="relative"
                  style={{ height: 60 * PX_PER_MINUTE }}
                >
                  <span className="tnum absolute -top-8 right-8 font-mono text-12 text-faint">
                    {formatHourLabel(firstHour + i)}
                  </span>
                </div>
              ))}
            </div>

            {days.map((day) => (
              <DayColumn
                key={day.toISODate()}
                day={day}
                meetings={byDay.get(day.toISODate() ?? '') ?? []}
                firstHour={firstHour}
                lastHour={lastHour}
                onSelect={onSelectMeeting}
                zone={zone}
              />
            ))}
          </div>
        </div>

        {isPending ? (
          <p className="absolute inset-x-0 top-48 text-center text-13 text-faint">
            Loading…
          </p>
        ) : null}
      </div>
    </section>
  );
}
