/** Pixels per minute. 60px to the hour. */
export const PX_PER_MINUTE = 1;

/** Hour rows rendered by default. Extended to cover anything outside them. */
export const DEFAULT_FIRST_HOUR = 7;
export const DEFAULT_LAST_HOUR = 21;

/**
 * Working hours, as a placeholder.
 *
 * The brief asks for working hours in --surface and non-working in --bg, but
 * §5 exposes no working-hours field: `Policy` carries durations, notice and
 * caps, and nothing about when the day starts. The frontend must not invent
 * this — deciding what counts as working time is scheduling truth and belongs
 * to the backend.
 *
 * So these constants shade the grid for now and are flagged for the backend
 * team as a contract gap. When `Policy` (or a new endpoint) grows the real
 * hours, this constant is deleted and the value is read from the API.
 */
export const PLACEHOLDER_WORKING_HOURS = { start: 9, end: 18 } as const;
