import { apiFetch } from './client';
import type { LoginRequest, LoginResponse, Person, RefreshResponse } from './types';

export function login(body: LoginRequest): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body,
    // The login request itself carries no bearer token.
    token: null,
  });
}

export function refresh(): Promise<RefreshResponse> {
  return apiFetch<RefreshResponse>('/api/auth/refresh', {
    method: 'POST',
    token: null,
  });
}

export function logout(): Promise<void> {
  return apiFetch<void>('/api/auth/logout', { method: 'POST' });
}

export function fetchMe(token?: string | null): Promise<Person> {
  return apiFetch<Person>('/api/me', token !== undefined ? { token } : {});
}
