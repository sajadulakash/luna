/**
 * A small pulsing dot while waiting for the first token. It disappears the
 * instant text begins.
 *
 * `tool_start` is optional to render, but a quiet "checking the calendar…"
 * line makes the two-second wait feel like work rather than lag.
 */

interface ThinkingIndicatorProps {
  /** The tool Luna is running right now, if any. */
  tool?: string | null;
}

/** Tool names are snake_case on the wire; these are the human readings. */
const TOOL_LABELS: Record<string, string> = {
  list_meetings: 'checking the calendar',
  check_availability: 'looking for open times',
  book_meeting: 'booking it in',
  reschedule_meeting: 'moving it',
  cancel_meeting: 'cancelling that',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ');
}

export function ThinkingIndicator({ tool }: ThinkingIndicatorProps) {
  return (
    <div
      className="flex flex-col gap-4 py-4"
      role="status"
      aria-live="polite"
      aria-label={tool ? `Luna is ${toolLabel(tool)}` : 'Luna is thinking'}
    >
      <span className="flex h-16 items-center px-4">
        <span
          className="block h-8 w-8 rounded-pill bg-accent motion-safe:animate-luna-pulse-dot"
          aria-hidden="true"
        />
      </span>

      {tool ? (
        <span className="px-4 text-13 text-muted">{toolLabel(tool)}…</span>
      ) : null}
    </div>
  );
}
