import { create } from 'zustand';
import { configureApi } from '../api/client';
import * as authApi from '../api/auth';
import type { Person } from '../api/types';

/**
 * Owner session.
 *
 * The access token lives here and nowhere else. It is never written to
 * localStorage or sessionStorage — the long-lived credential is the httpOnly
 * refresh cookie, which JavaScript cannot read, and that is the whole point of
 * the split. A page reload deliberately starts with no token and recovers it
 * through a silent refresh.
 */

export type AuthStatus =
  | 'unknown'        // haven't tried to restore a session yet
  | 'restoring'      // silent refresh in flight
  | 'authenticated'
  | 'anonymous';

interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  user: Person | null;
  /** Set when a login attempt fails. Shown inline beneath the field. */
  error: string | null;

  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  /** Silent refresh on load, so a reload doesn't bounce the owner to /login. */
  restore: () => Promise<void>;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'unknown',
  accessToken: null,
  user: null,
  error: null,

  login: async (username, password) => {
    set({ error: null });
    try {
      const res = await authApi.login({ username, password });
      set({
        status: 'authenticated',
        accessToken: res.access_token,
        user: res.user,
        error: null,
      });
      return true;
    } catch (cause) {
      set({
        status: 'anonymous',
        accessToken: null,
        user: null,
        error:
          cause instanceof Error && cause.message
            ? cause.message
            : "That didn't work. Check your username and password.",
      });
      return false;
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // The cookie may already be gone. Local state is cleared either way.
    }
    get().clear();
  },

  restore: async () => {
    if (get().status === 'restoring') return;
    set({ status: 'restoring' });

    try {
      const res = await authApi.refresh();
      const user = await authApi.fetchMe(res.access_token);
      set({ status: 'authenticated', accessToken: res.access_token, user });
    } catch {
      set({ status: 'anonymous', accessToken: null, user: null });
    }
  },

  clear: () => set({ status: 'anonymous', accessToken: null, user: null }),
}));

/**
 * Wires the store into the fetch wrapper.
 *
 * Called once from main.tsx. Keeping it here rather than inside client.ts
 * means the client has no dependency on React or Zustand and stays testable
 * on its own.
 */
export function installOwnerAuth(onAuthFailure?: () => void): void {
  configureApi({
    getAuth: () => ({ mode: 'owner', token: useAuthStore.getState().accessToken }),

    refresh: async () => {
      try {
        const res = await authApi.refresh();
        useAuthStore.setState({
          status: 'authenticated',
          accessToken: res.access_token,
        });
        return res.access_token;
      } catch {
        return null;
      }
    },

    onAuthFailure: () => {
      // Clearing the store flips `status` to anonymous, and the route guard
      // redirects on the next render — no imperative navigation from here.
      useAuthStore.getState().clear();
      onAuthFailure?.();
    },
  });
}
