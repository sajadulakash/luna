import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRefreshState,
  apiFetch,
  ApiRequestError,
  ConflictError,
  configureApi,
} from './client';

/**
 * The 401 path, which is easy to get subtly wrong: several queries failing in
 * the same tick must produce one refresh between them, and a refresh that
 * fails must clear the session rather than retrying forever.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetRefreshState();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the bearer token and returns the parsed body', async () => {
    configureApi({
      getAuth: () => ({ mode: 'owner', token: 'access-1' }),
      refresh: async () => null,
      onAuthFailure: () => {},
    });
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'p_owner' }));

    await expect(apiFetch<{ id: string }>('/api/me')).resolves.toEqual({
      id: 'p_owner',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access-1');
    expect(init.credentials).toBe('include');
  });

  it('refreshes once and retries the original request on a 401', async () => {
    const refresh = vi.fn(async () => 'access-2');
    const onAuthFailure = vi.fn();
    configureApi({
      getAuth: () => ({ mode: 'owner', token: 'expired' }),
      refresh,
      onAuthFailure,
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'expired', message: 'nope' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(apiFetch('/api/meetings')).resolves.toEqual({ ok: true });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onAuthFailure).not.toHaveBeenCalled();

    const [, retryInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(new Headers(retryInit.headers).get('Authorization')).toBe('Bearer access-2');
  });

  it('refreshes only once when several requests 401 together', async () => {
    const refresh = vi.fn(async () => 'access-2');
    configureApi({
      getAuth: () => ({ mode: 'owner', token: 'expired' }),
      refresh,
      onAuthFailure: () => {},
    });

    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('Authorization');
      return Promise.resolve(
        auth === 'Bearer access-2'
          ? jsonResponse(200, { ok: true })
          : jsonResponse(401, { error: 'expired', message: 'nope' }),
      );
    });

    await Promise.all([
      apiFetch('/api/meetings'),
      apiFetch('/api/slots'),
      apiFetch('/api/policies'),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('clears the session when the refresh itself fails', async () => {
    const onAuthFailure = vi.fn();
    configureApi({
      getAuth: () => ({ mode: 'owner', token: 'expired' }),
      refresh: async () => null,
      onAuthFailure,
    });

    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'expired', message: 'nope' }));

    await expect(apiFetch('/api/meetings')).rejects.toBeInstanceOf(ApiRequestError);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    // One attempt, no retry — the refresh never produced a usable token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never refreshes for an employee — the link is simply dead', async () => {
    const refresh = vi.fn(async () => 'access-2');
    configureApi({
      getAuth: () => ({ mode: 'employee', token: 'k7m2x9' }),
      refresh,
      onAuthFailure: () => {},
    });

    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: 'invalid_token', message: 'gone' }),
    );

    const error = await apiFetch('/api/chat/history').catch((cause: unknown) => cause);

    expect(refresh).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).isDeadLink).toBe(true);
  });

  it('surfaces a 409 as a ConflictError carrying the alternatives', async () => {
    configureApi({
      getAuth: () => ({ mode: 'owner', token: 'access-1' }),
      refresh: async () => null,
      onAuthFailure: () => {},
    });

    const alternatives = [
      { start: '2026-08-25T08:00:00Z', end: '2026-08-25T08:30:00Z', label: 'Tuesday at 2:00 PM' },
    ];
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: 'conflict', reason: 'booked', alternatives }),
    );

    const error = await apiFetch('/api/meetings', {
      method: 'POST',
      body: { title: 'x' },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).reason).toBe('booked');
    expect((error as ConflictError).alternatives).toEqual(alternatives);
  });

  it('resolves to undefined for a 204', async () => {
    configureApi({
      getAuth: () => ({ mode: 'owner', token: 'access-1' }),
      refresh: async () => null,
      onAuthFailure: () => {},
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(apiFetch('/api/meetings/mtg_1', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});
