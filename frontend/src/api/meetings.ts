import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiFetch } from './client';
import type {
  CancelRequest,
  CreateMeetingRequest,
  Meeting,
  Policy,
  RescheduleRequest,
  Slot,
} from './types';

/**
 * Server state for meetings, slots and policies.
 *
 * Every list here arrives ordered and filtered. Nothing in this file re-sorts,
 * re-ranks or slices — if the ordering looks wrong that is a backend bug to
 * report, not something to paper over on the client.
 */

export const queryKeys = {
  meetings: (from: string, to: string, scope = 'owner') =>
    ['meetings', scope, from, to] as const,
  /** Prefix for invalidation — matches every window currently cached. */
  allMeetings: ['meetings'] as const,
  employeeMeetings: (token: string | null) =>
    ['meetings', `employee:${token ?? 'missing'}`] as const,
  slots: (from: string, to: string, duration: number) =>
    ['slots', from, to, duration] as const,
  policies: ['policies'] as const,
  chatHistory: (token: string | null) => ['chat-history', token] as const,
} as const;

export function useMeetings(
  from: string,
  to: string,
  enabled = true,
  token?: string | null,
): UseQueryResult<Meeting[]> {
  const scope = token === undefined ? 'owner' : `employee:${token ?? 'missing'}`;

  return useQuery({
    queryKey: queryKeys.meetings(from, to, scope),
    queryFn: () =>
      apiFetch<Meeting[]>(
        `/api/meetings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        token !== undefined ? { token } : {},
      ),
    enabled,
  });
}

export function useSlots(
  from: string,
  to: string,
  durationMinutes: number,
  enabled = true,
): UseQueryResult<Slot[]> {
  return useQuery({
    queryKey: queryKeys.slots(from, to, durationMinutes),
    queryFn: () =>
      apiFetch<Slot[]>(
        `/api/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
          `&duration_minutes=${durationMinutes}`,
      ),
    enabled,
  });
}

/**
 * Books a meeting.
 *
 * A 409 rejects with a ConflictError carrying the alternatives. Callers render
 * that as Luna offering other times — it is not an error state.
 */
export function useCreateMeeting(): UseMutationResult<
  Meeting,
  Error,
  CreateMeetingRequest
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateMeetingRequest) =>
      apiFetch<Meeting>('/api/meetings', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.allMeetings });
    },
  });
}

export function useRescheduleMeeting(): UseMutationResult<
  Meeting,
  Error,
  { id: string } & RescheduleRequest
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, start }) =>
      apiFetch<Meeting>(`/api/meetings/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { start },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.allMeetings });
    },
  });
}

export function useCancelMeeting(): UseMutationResult<
  void,
  Error,
  { id: string } & CancelRequest
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, reason }) =>
      apiFetch<void>(`/api/meetings/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { reason },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.allMeetings });
    },
  });
}

export function usePolicies(enabled = true): UseQueryResult<Policy> {
  return useQuery({
    queryKey: queryKeys.policies,
    queryFn: () => apiFetch<Policy>('/api/policies'),
    enabled,
  });
}
