import type { ConflictReason } from '../../api/types';

/**
 * A single line above the alternatives, in --busy.
 *
 * Not a banner, not an icon, not an alert. A 409 or a conflict event is a
 * normal outcome — someone taking a slot a second before you is expected
 * behaviour, and it should read like Luna mentioning it, not like a failure.
 */

const REASONS: Record<ConflictReason, string> = {
  booked: 'That time is already taken.',
  outside_hours: "That's outside working hours.",
  too_soon: "That's too soon to book.",
  blackout: "That time is blocked off.",
  day_full: "That day is fully booked.",
};

export function ConflictLine({ reason }: { reason: ConflictReason }) {
  return <p className="mb-8 text-15 text-busy">{REASONS[reason]}</p>;
}
