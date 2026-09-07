import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiFetch } from './client';
import { queryKeys } from './meetings';
import type { Meeting } from './types';

/**
 * The notification panel.
 *
 * Notifications are their own resource rather than chat messages: they carry a
 * read state, and a meeting request carries two buttons that must stop working
 * the moment either is pressed — including on a panel that has been open in
 * another tab since yesterday. `actionable` is decided by the server from the
 * meeting's current status, never by the client from what it drew earlier.
 */

export type NotificationKind =
  | 'MEETING_REQUEST'
  | 'MEETING_APPROVED'
  | 'MEETING_DECLINED'
  | 'MEETING_BOOKED'
  | 'MEETING_MOVED'
  | 'MEETING_CANCELLED'
  | 'MEETING_UPDATED';

export interface Notification {
  id: string;
  kind: NotificationKind;
  body: string;
  created_at: string;
  read: boolean;
  /** True only while the request is still unanswered. Drives the buttons. */
  actionable: boolean;
  meeting: Meeting | null;
}

export interface NotificationFeed {
  notifications: Notification[];
  unread: number;
}

export const notificationKeys = {
  all: ['notifications'] as const,
};

export function useNotifications(): UseQueryResult<NotificationFeed> {
  return useQuery({
    queryKey: notificationKeys.all,
    // No explicit token: the session in the store is the only one there is
    // now, and going through it keeps the 401 refresh-and-retry.
    queryFn: () => apiFetch<NotificationFeed>('/api/notifications'),
    // A request can arrive while you are looking at something else, so the
    // badge has to find out on its own.
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<void>('/api/notifications/read', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

/**
 * Approve or decline a request.
 *
 * Both invalidate the calendar as well as the panel: approving is the moment
 * the meeting actually appears, and a stale week view would not show it.
 */
export function useAnswerRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, answer }: { id: string; answer: 'approve' | 'decline' }) =>
      apiFetch<{ meeting: Meeting }>(
        `/api/meetings/${encodeURIComponent(id)}/${answer}`,
        { method: 'POST' },
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allMeetings });
    },
  });
}
