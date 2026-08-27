import { API_BASE_URL } from '../lib/env';
import type { ApiError, ConflictReason, ConflictResponse, Slot } from './types';

/**
 * The fetch wrapper. Base URL, auth header, and the 401 refresh-and-retry.
 *
 * Two auth models live here side by side and are deliberately *not* unified
 * (§5): an employee carries a token from the URL and can never refresh, while
 * an owner holds a short-lived token in memory backed by an httpOnly refresh
 * cookie.
 */

export type AuthMode = 'owner' | 'employee';

export interface AuthSnapshot {
  mode: AuthMode;
  token: string | null;
}

interface ApiConfig {
  /** Reads the live token and mode. Called per request, never cached. */
  getAuth: () => AuthSnapshot;
  /** Owner only. Resolves to the new access token, or null if refresh failed. */
  refresh: () => Promise<string | null>;
  /** Owner only. Refresh failed — clear state and route to /login. */
  onAuthFailure: () => void;
}

let config: ApiConfig = {
  getAuth: () => ({ mode: 'owner', token: null }),
  refresh: async () => null,
  onAuthFailure: () => {},
};

/** Installed once at startup by the auth store. Keeps client.ts store-free. */
export function configureApi(next: Partial<ApiConfig>): void {
  config = { ...config, ...next };
}

// --- Errors -----------------------------------------------------------------

export class ApiRequestError extends Error {
  readonly status: number;
  /** Machine-readable code from the API body, e.g. "invalid_token". */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }

  /** The employee's link has expired or was revoked — show the dead-link page. */
  get isDeadLink(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * A 409 from POST /api/meetings. This is a normal outcome, not a failure:
 * render it as Luna offering the alternatives, never as a red error toast.
 */
export class ConflictError extends ApiRequestError {
  readonly reason: ConflictReason;
  readonly alternatives: Slot[];

  constructor(reason: ConflictReason, alternatives: Slot[]) {
    super(409, 'conflict', 'That time is no longer available.');
    this.name = 'ConflictError';
    this.reason = reason;
    this.alternatives = alternatives;
  }
}

/** The request never reached the API — offline, DNS, backend down mid-flight. */
export class NetworkError extends ApiRequestError {
  constructor(message: string) {
    super(0, 'network_error', message);
    this.name = 'NetworkError';
  }
}

// --- Refresh single-flight --------------------------------------------------

// Several queries can 401 in the same tick. They must produce exactly one
// call to /api/auth/refresh, not one each — so everyone awaits the same promise.
let inFlightRefresh: Promise<string | null> | null = null;

function refreshOnce(): Promise<string | null> {
  if (!inFlightRefresh) {
    inFlightRefresh = config.refresh().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

// --- Request ----------------------------------------------------------------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Overrides the stored token. The employee routes pass the URL token. */
  token?: string | null;
}

function buildHeaders(token: string | null, hasBody: boolean): Headers {
  const headers = new Headers();
  if (hasBody) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

async function readError(res: Response): Promise<ApiRequestError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body (a proxy's HTML 502 page, say). Fall through.
  }

  if (res.status === 409 && isConflictBody(body)) {
    return new ConflictError(body.reason, body.alternatives);
  }

  if (isApiErrorBody(body)) {
    return new ApiRequestError(res.status, body.error, body.message);
  }

  return new ApiRequestError(
    res.status,
    'unexpected_error',
    `Request failed (${res.status}).`,
  );
}

function isApiErrorBody(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiError).error === 'string' &&
    typeof (value as ApiError).message === 'string'
  );
}

function isConflictBody(value: unknown): value is ConflictResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ConflictResponse).error === 'conflict' &&
    Array.isArray((value as ConflictResponse).alternatives)
  );
}

async function send(
  path: string,
  options: RequestOptions,
  token: string | null,
): Promise<Response> {
  const hasBody = options.body !== undefined;

  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: buildHeaders(token, hasBody),
      body: hasBody ? JSON.stringify(options.body) : undefined,
      // The refresh cookie crosses origins, so credentials go on every request.
      // This requires allow_credentials=True and an explicit origin list on
      // the backend — a wildcard origin silently breaks credentialed requests.
      credentials: 'include',
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError("I couldn't reach the server.");
  }
}

/**
 * Performs a request, applying the auth model for the current mode.
 *
 * Owner: on a 401, refreshes once and retries the original request exactly
 * once. If the refresh also fails, state is cleared and the app routes to
 * /login.
 *
 * Employee: a 401 or 403 is terminal — there is no login to fall back to.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const auth = config.getAuth();
  const token = options.token !== undefined ? options.token : auth.token;

  let res = await send(path, options, token);

  if (res.status === 401 && auth.mode === 'owner' && options.token === undefined) {
    const fresh = await refreshOnce();

    if (!fresh) {
      config.onAuthFailure();
      throw await readError(res);
    }

    // One retry. If this 401s too, it surfaces as an error rather than
    // looping — a refresh token that yields an unusable access token is a
    // backend problem, and retrying forever would just hide it.
    res = await send(path, options, fresh);

    if (res.status === 401) {
      config.onAuthFailure();
      throw await readError(res);
    }
  }

  if (!res.ok) throw await readError(res);

  // 204 No Content — logout, cancel.
  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}

/** Exposed for tests only: drops any refresh currently in flight. */
export function __resetRefreshState(): void {
  inFlightRefresh = null;
}
