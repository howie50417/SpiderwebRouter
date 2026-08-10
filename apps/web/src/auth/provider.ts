import type { AuthProvider } from '@refinedev/core';

import { ApiError, apiClient } from '@/api/client';
import { endpoints } from '@/api/endpoints';
import { consoleLoginHref, currentReturnTo, sanitizeReturnTo } from '@/auth/returnTo';
import { registerIdentityReset } from '@/auth/sessionExpiry';
import type { AppLocale } from '@/context/AppSettings';
import type { Identity } from '@/types';

let cachedIdentity: Identity | undefined;
let identityRequest: Promise<Identity> | undefined;

export function loginHref(returnTo = '/', locale: AppLocale = 'zh-TW'): string {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  const oidcLocale = locale === 'en-US' ? 'en' : 'zh-TW';
  return `/auth/login?returnTo=${encodeURIComponent(safeReturnTo)}&locale=${encodeURIComponent(oidcLocale)}`;
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

registerIdentityReset(clearIdentity);

export const authProvider: AuthProvider = {
  login: async (params) => {
    const returnTo = sanitizeReturnTo(params?.returnTo);
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
      if (!(error instanceof ApiError) || error.status !== 401) {
        return { authenticated: true, error: error as Error };
      }
      clearIdentity();
      return {
        authenticated: false,
        error: error as Error,
        redirectTo: consoleLoginHref(currentReturnTo(), true),
        logout: false,
      };
    }
  },
  getIdentity: () => loadIdentity(),
  getPermissions: async () => (await loadIdentity()).roles,
  onError: async (error) => {
    if (error instanceof ApiError && error.status === 401) {
      clearIdentity();
      return { logout: false, redirectTo: consoleLoginHref(currentReturnTo(), true), error };
    }
    return { error };
  },
};
