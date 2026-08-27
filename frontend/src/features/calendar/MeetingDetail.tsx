import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { DateTime } from 'luxon';
import type { Meeting, Slot } from '../../api/types';
import { useCancelMeeting, useRescheduleMeeting, useSlots } from '../../api/meetings';
import { formatDayLong, formatTimeRange, spanMinutes, toApi } from '../../lib/datetime';
import { SlotCards } from '../chat/SlotCards';

/**
 * The meeting panel: title, requester, notes, Cancel and Reschedule.
 *
 * A bottom sheet, because this opens from a tap near the bottom of a phone
 * screen and a centred dialog would land under the thumb.
 *
 * Rescheduling offers times from `GET /api/slots` rather than a time picker.
 * The frontend has no way to know what is free, and a picker that lets the
 * owner choose a taken time only to bounce off a 409 is worse than offering
 * the three the backend already ranked.
 */

interface MeetingDetailProps {
  meeting: Meeting;
  onClose: () => void;
  /** Owner controls are hidden in employee calendars. */
  editable?: boolean;
}

export function MeetingDetail({ meeting, onClose, editable = true }: MeetingDetailProps) {
  const [mode, setMode] = useState<'view' | 'reschedule'>('view');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const cancel = useCancelMeeting();
  const reschedule = useRescheduleMeeting();

  const duration = Math.round(spanMinutes(meeting.start_at, meeting.end_at));

  // A fortnight is a reasonable window to offer; the API caps how far ahead it
  // will actually go via `max_days_ahead`.
  //
  // Pinned on mount rather than recomputed each render: `DateTime.local()`
  // returns a new instant every time, which would change the query key on
  // every render and leave the request permanently in flight.
  const [range] = useState(() => ({
    from: toApi(DateTime.local()),
    to: toApi(DateTime.local().plus({ days: 14 })),
  }));
  const { data: slots, isPending: slotsPending } = useSlots(
    range.from,
    range.to,
    duration,
    editable && mode === 'reschedule',
  );

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const choose = (slot: Slot) => {
    reschedule.mutate(
      { id: meeting.id, start: slot.start },
      { onSuccess: onClose },
    );
  };

  const busy = cancel.isPending || reschedule.isPending;

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={meeting.title}
        className={[
          'relative flex max-h-[85vh] w-full flex-col overflow-y-auto',
          'rounded-card border border-line bg-surface',
          'px-16 pb-safe pt-16 sm:max-w-chat',
          'motion-safe:animate-luna-rise',
        ].join(' ')}
      >
        <div className="flex items-start justify-between gap-12 pb-16">
          <div className="min-w-0">
            <h2 className="text-20 font-semibold text-ink">{meeting.title}</h2>
            <p className="tnum mt-4 font-mono text-13 text-muted">
              {formatDayLong(meeting.start_at)} ·{' '}
              {formatTimeRange(meeting.start_at, meeting.end_at)}
            </p>
          </div>

          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="tap -mr-8 -mt-8 flex shrink-0 items-center justify-center rounded-control text-muted transition-colors duration-150 ease-out hover:text-ink"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <dl className="flex flex-col gap-12 border-t border-line py-16">
          <Row label="Requested by" value={meeting.requested_by?.name ?? 'Rafi'} />
          <Row label="Booked via" value={bookedViaLabel(meeting.booked_via)} />
          {meeting.notes ? <Row label="Notes" value={meeting.notes} /> : null}
          {meeting.status === 'CANCELLED' ? (
            <Row label="Status" value="Cancelled" tone="busy" />
          ) : null}
        </dl>

        {!editable ? null : mode === 'view' ? (
          <div className="flex gap-8 border-t border-line pb-16 pt-16">
            <button
              type="button"
              disabled={busy || meeting.status === 'CANCELLED'}
              onClick={() => setMode('reschedule')}
              className="tap flex-1 rounded-control border border-line bg-surface px-16 text-15 text-ink transition-colors duration-150 ease-out hover:border-accent disabled:opacity-50"
            >
              Reschedule
            </button>
            <button
              type="button"
              disabled={busy || meeting.status === 'CANCELLED'}
              onClick={() => cancel.mutate({ id: meeting.id }, { onSuccess: onClose })}
              className="tap flex-1 rounded-control border border-busy bg-surface px-16 text-15 text-busy transition-colors duration-150 ease-out disabled:opacity-50"
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel'}
            </button>
          </div>
        ) : (
          <div className="border-t border-line pb-16 pt-16">
            <p className="pb-8 text-15 text-muted">Move it to:</p>

            {slotsPending ? (
              <p className="text-13 text-faint">Finding open times…</p>
            ) : slots?.length ? (
              <SlotCards slots={slots} onChoose={choose} disabled={busy} />
            ) : (
              <p className="text-15 text-busy">No open times in the next fortnight.</p>
            )}

            <button
              type="button"
              onClick={() => setMode('view')}
              className="tap mt-12 w-full rounded-control border border-line px-16 text-15 text-muted transition-colors duration-150 ease-out hover:border-accent"
            >
              Back
            </button>
          </div>
        )}

        {editable && (cancel.isError || reschedule.isError) ? (
          <p role="alert" className="pb-16 text-15 text-busy">
            That didn&apos;t go through. Try again in a moment.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone = 'ink',
}: {
  label: string;
  value: string;
  tone?: 'ink' | 'busy';
}) {
  return (
    <div className="flex flex-col gap-4">
      <dt className="text-12 text-faint">{label}</dt>
      <dd className={`text-15 ${tone === 'busy' ? 'text-busy' : 'text-ink'}`}>
        {value}
      </dd>
    </div>
  );
}

function bookedViaLabel(via: Meeting['booked_via']): string {
  switch (via) {
    case 'VOICE':
      return 'Voice';
    case 'CHAT':
      return 'Chat';
    case 'OWNER':
      return 'Added by Rafi';
  }
}
