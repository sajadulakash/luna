import { DateTime, Duration, Interval } from 'luxon';

/**
 * Every Luxon call in the app lives in this file.
 *
 * Two rules from the brief are enforced by keeping it that way:
 * timestamps arrive as UTC ISO strings and are converted to the viewer's zone
 * at render time only, and no local-time string is ever stored. Nothing here
 * decides whether a slot is free or when a meeting ends — that is the
 * backend's job, and this module only ever formats or positions what it sent.
 */

/** Parses an API timestamp into the viewer's zone. */
export function fromApi(iso: string, zone?: string): DateTime {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone ?? DateTime.local().zoneName);
}

/** Formats a timestamp for sending back to the API: always UTC, always `Z`. */
export function toApi(dt: DateTime): string {
  return dt.toUTC().toISO({ suppressMilliseconds: true }) ?? '';
}

/** The viewer's IANA zone, e.g. "Asia/Dhaka". */
export function viewerZone(): string {
  return DateTime.local().zoneName;
}

// --- Display ----------------------------------------------------------------

/** "2:00 PM" */
export function formatTime(iso: string, zone?: string): string {
  return fromApi(iso, zone).toFormat('h:mm a');
}

/** "Tue 25 Aug" */
export function formatDayShort(iso: string, zone?: string): string {
  return fromApi(iso, zone).toFormat('ccc d LLL');
}

/** "Tuesday, 25 August" */
export function formatDayLong(iso: string, zone?: string): string {
  return fromApi(iso, zone).toFormat('cccc, d LLLL');
}

/** "2:00 – 2:30 PM", collapsing the meridiem when both ends share it. */
export function formatTimeRange(startIso: string, endIso: string, zone?: string): string {
  const start = fromApi(startIso, zone);
  const end = fromApi(endIso, zone);
  const sameMeridiem = start.toFormat('a') === end.toFormat('a');
  const left = sameMeridiem ? start.toFormat('h:mm') : start.toFormat('h:mm a');
  return `${left} – ${end.toFormat('h:mm a')}`;
}

/** "30 min", "1 hr", "1 hr 30 min" — read from the API's own start and end. */
export function formatDuration(startIso: string, endIso: string): string {
  const minutes = Interval.fromDateTimes(
    DateTime.fromISO(startIso, { zone: 'utc' }),
    DateTime.fromISO(endIso, { zone: 'utc' }),
  ).length('minutes');

  if (!Number.isFinite(minutes) || minutes <= 0) return '';

  const dur = Duration.fromObject({ minutes }).shiftTo('hours', 'minutes');
  const hours = Math.floor(dur.hours);
  const mins = Math.round(dur.minutes);

  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

/** True when the two timestamps fall on different days in the viewer's zone. */
export function isNewDay(iso: string, previousIso: string | null, zone?: string): boolean {
  if (!previousIso) return true;
  return !fromApi(iso, zone).hasSame(fromApi(previousIso, zone), 'day');
}

/** "Today", "Yesterday", or "Tuesday, 25 August". Used for chat day dividers. */
export function formatDayDivider(iso: string, zone?: string): string {
  const day = fromApi(iso, zone);
  const today = DateTime.local().setZone(zone ?? viewerZone());

  if (day.hasSame(today, 'day')) return 'Today';
  if (day.hasSame(today.minus({ days: 1 }), 'day')) return 'Yesterday';
  return formatDayLong(iso, zone);
}

// --- Calendar positioning ---------------------------------------------------

/** The seven days of the week containing `reference`, Monday first. */
export function weekDays(reference: DateTime, zone?: string): DateTime[] {
  const start = reference.setZone(zone ?? viewerZone()).startOf('week');
  return Array.from({ length: 7 }, (_, i) => start.plus({ days: i }));
}

/** Inclusive UTC bounds for a `GET /api/meetings?from=&to=` over that week. */
export function weekRange(reference: DateTime, zone?: string): { from: string; to: string } {
  const days = weekDays(reference, zone);
  return {
    from: toApi(days[0]!.startOf('day')),
    to: toApi(days[6]!.endOf('day')),
  };
}

/** Minutes from local midnight — the vertical offset for a calendar block. */
export function minutesFromMidnight(iso: string, zone?: string): number {
  const dt = fromApi(iso, zone);
  return dt.hour * 60 + dt.minute;
}

/**
 * How long a meeting occupies the calendar, in minutes.
 *
 * This is arithmetic on the two timestamps the API already sent, not a
 * derivation of when something ends — the frontend never adds a duration to a
 * start time to find an end.
 */
export function spanMinutes(startIso: string, endIso: string): number {
  const minutes = Interval.fromDateTimes(
    DateTime.fromISO(startIso, { zone: 'utc' }),
    DateTime.fromISO(endIso, { zone: 'utc' }),
  ).length('minutes');
  return Number.isFinite(minutes) ? minutes : 0;
}

/** True when `day` is the viewer's today. */
export function isToday(day: DateTime, zone?: string): boolean {
  return day.hasSame(DateTime.local().setZone(zone ?? viewerZone()), 'day');
}

/** Minutes from midnight for right now, for the current-time line. */
export function nowMinutes(zone?: string): number {
  const now = DateTime.local().setZone(zone ?? viewerZone());
  return now.hour * 60 + now.minute;
}

/** "09:00" for the hour gutter. */
export function formatHourLabel(hour: number): string {
  return DateTime.fromObject({ hour }).toFormat('HH:mm');
}

export { DateTime };
