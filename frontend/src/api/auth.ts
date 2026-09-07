import { apiFetch } from './client';
import type {
  LoginRequest,
  LoginResponse,
  Person,
  RefreshResponse,
  RegisterRequest,
  RegisterResponse,
} from './types';

export function login(body: LoginRequest): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body,
    // The login request itself carries no bearer token.
    token: null,
  });
}

/** The department list, so the form and the server cannot disagree. */
export function fetchDepartments(): Promise<string[]> {
  return apiFetch<string[]>('/api/departments', { token: null });
}

export function register(body: RegisterRequest): Promise<RegisterResponse> {
  return apiFetch<RegisterResponse>('/api/auth/register', {
    method: 'POST',
    body,
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
