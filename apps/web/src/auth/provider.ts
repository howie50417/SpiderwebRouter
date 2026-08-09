import type { AuthProvider } from '@refinedev/core';

import { ApiError, apiClient } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import type { Identity } from '@/types';

let cachedIdentity: Identity | undefined;
let identityRequest: Promise<Identity> | undefined;

export function loginHref(returnTo = '/'): string {
  const safeReturnTo = returnTo.startsWith('/') ? returnTo : '/';
  return `/auth/login?returnTo=${encodeURIComponent(safeReturnTo)}`;
}

async function loadIdentity(force = false): Promise<Identity> {
  if (!force && cachedIdentity) return cachedIdentity;
  if (!force && identityRequest) return identityRequest;

  identityRequest = apiClient.get<Identity>(endpoints.identity);
  try {
    cachedIdentity = await identityRequest;
    return cachedIdentity;
  } finally {
    identityRequest = undefined;
  }
}

export function clearIdentity(): void {
  cachedIdentity = undefined;
  identityRequest = undefined;
}

export const authProvider: AuthProvider = {
  login: async (params) => {
    const returnTo = typeof params?.returnTo === 'string' ? params.returnTo : '/';
    window.location.assign(loginHref(returnTo));
    return { success: true };
  },
  logout: async () => {
    clearIdentity();
    window.location.assign('/auth/logout');
    return { success: true, redirectTo: '/login' };
  },
  check: async () => {
    try {
      await loadIdentity();
      return { authenticated: true };
    } catch (error) {
      clearIdentity();
      return {
        authenticated: false,
        error: error as Error,
        redirectTo: '/login',
        logout: error instanceof ApiError && error.status === 401,
      };
    }
  },
  getIdentity: () => loadIdentity(),
  getPermissions: async () => (await loadIdentity()).roles,
  onError: async (error) => {
    if (error instanceof ApiError && error.status === 401) {
      clearIdentity();
      return { logout: true, redirectTo: '/login', error };
    }
    return { error };
  },
};
