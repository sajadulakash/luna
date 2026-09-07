import { useEffect, useRef, useState } from 'react';
import { Bell, Check, X } from 'lucide-react';
import {
  useAnswerRequest,
  useMarkNotificationsRead,
  useNotifications,
  type Notification,
} from '../api/notifications';
import { formatDayLong, formatTimeRange, fromApi } from '../lib/datetime';

/**
 * The bell, and the panel behind it.
 *
 * One component for both roles. The difference between what the boss sees and
 * what an employee sees is not a prop: it is that only a request addressed to
 * the boss is ever `actionable`, and the server decides that from the
 * meeting's current status. So a panel left open overnight cannot offer to
 * approve something that was answered hours ago — the buttons are gone the
 * next time it loads, and pressing a stale one is refused anyway.
 */

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const { data } = useNotifications();
  const markRead = useMarkNotificationsRead();

  const items = data?.notifications ?? [];
  const badge = data?.unread ?? 0;

  // Opening it is reading it — but requests keep their badge until answered,
  // which the server handles, so this does not silence anything outstanding.
  useEffect(() => {
    if (open && items.some((item) => !item.read)) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={panelRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={badge > 0 ? `Notifications, ${badge} waiting` : 'Notifications'}
        aria-expanded={open}
        className="tap relative flex items-center justify-center px-16 text-faint transition-colors duration-150 ease-out hover:text-ink"
      >
        <Bell size={18} aria-hidden="true" />
        {badge > 0 ? (
          <span
            aria-hidden="true"
            className="tnum absolute right-8 top-4 min-w-16 rounded-pill bg-busy px-4 text-center font-mono text-12 text-surface"
          >
            {badge > 9 ? '9+' : badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-8 top-full z-30 max-h-[70vh] w-[min(360px,calc(100vw-32px))] overflow-y-auto rounded-card border border-line bg-surface motion-safe:animate-luna-rise"
        >
          {items.length === 0 ? (
            <p className="px-16 py-24 text-center text-13 text-muted">
              Nothing yet.
            </p>
          ) : (
            <ul className="flex flex-col">
              {items.map((item) => (
                <li key={item.id} className="border-b border-line last:border-b-0">
                  <NotificationRow item={item} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function NotificationRow({ item }: { item: Notification }) {
  const answer = useAnswerRequest();
  const [failed, setFailed] = useState<string | null>(null);

  const respond = (choice: 'approve' | 'decline') => {
    setFailed(null);
    answer.mutate(
      { id: item.meeting?.id ?? '', answer: choice },
      {
        onError: (cause) =>
          setFailed(
            cause instanceof Error ? cause.message : "That didn't go through.",
          ),
      },
    );
  };

  return (
    <div className={`flex flex-col gap-8 px-16 py-12 ${item.read ? '' : 'bg-accent-soft'}`}>
      <p className="text-15 text-ink">{item.body}</p>

      {item.meeting ? (
        <p className="tnum font-mono text-12 text-muted">
          {formatDayLong(item.meeting.start_at)} ·{' '}
          {formatTimeRange(item.meeting.start_at, item.meeting.end_at)}
        </p>
      ) : null}

      {item.actionable ? (
        <div className="flex gap-8 pt-4">
          <button
            type="button"
            disabled={answer.isPending}
            onClick={() => respond('approve')}
            className="tap flex flex-1 items-center justify-center gap-4 rounded-control bg-accent px-12 text-13 font-medium text-surface transition-opacity duration-150 ease-out disabled:opacity-60"
          >
            <Check size={14} aria-hidden="true" />
            Approve
          </button>
          <button
            type="button"
            disabled={answer.isPending}
            onClick={() => respond('decline')}
            className="tap flex flex-1 items-center justify-center gap-4 rounded-control border border-busy px-12 text-13 text-busy transition-opacity duration-150 ease-out disabled:opacity-60"
          >
            <X size={14} aria-hidden="true" />
            Decline
          </button>
        </div>
      ) : null}

      {failed ? (
        <p role="alert" className="text-13 text-busy">
          {failed}
        </p>
      ) : null}

      <time
        dateTime={item.created_at}
        className="tnum font-mono text-12 text-faint"
      >
        {fromApi(item.created_at).toRelative()}
      </time>
    </div>
  );
}
