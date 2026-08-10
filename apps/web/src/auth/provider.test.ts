import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authProvider, clearIdentity, loginHref } from '@/auth/provider';
import {
  resetUnauthorizedRedirectForTests,
  setUnauthorizedNavigationForTests,
} from '@/auth/sessionExpiry';

beforeEach(() => {
  clearIdentity();
  setUnauthorizedNavigationForTests(vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetUnauthorizedRedirectForTests();
});

describe('authProvider session errors', () => {
  it('maps the console locale to the safe Keycloak locale hint', () => {
    expect(loginHref('/usage', 'zh-TW')).toBe('/auth/login?returnTo=%2Fusage&locale=zh-TW');
    expect(loginHref('/usage', 'en-US')).toBe('/auth/login?returnTo=%2Fusage&locale=en');
  });

  it.each([403, 503])('does not log out or redirect on HTTP %s', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 'provider_unavailable' }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await authProvider.check?.({});
    expect(result).toMatchObject({ authenticated: true });
    expect(result).not.toHaveProperty('logout', true);
    expect(result).not.toHaveProperty('redirectTo');
  });

  it('marks only a 401 as expired without requesting the logout endpoint', async () => {
    const navigate = vi.fn();
    setUnauthorizedNavigationForTests(navigate);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 'authentication_error' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await authProvider.check?.({});
    expect(result).toMatchObject({ authenticated: false, logout: false });
    expect(result).toHaveProperty('redirectTo', '/login?returnTo=%2F&reason=expired');
    expect(navigate).toHaveBeenCalledOnce();
  });
});
