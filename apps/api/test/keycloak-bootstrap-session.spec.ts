import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureRealm } from '../src/bootstrap';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('existing Keycloak realm session settings', () => {
  it('reads, merges, and updates an existing realm without recreating it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'spiderwebrouter',
            realm: 'spiderwebrouter',
            displayName: 'Preserve me',
            smtpServer: { host: 'mail.internal' },
            ssoSessionIdleTimeout: 1800,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await ensureRealm(
      'https://keycloak.internal/auth',
      'spiderwebrouter',
      'admin-token',
      604_800,
      2_592_000,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [updateUrl, updateOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(updateUrl).toBe('https://keycloak.internal/auth/admin/realms/spiderwebrouter');
    expect(updateOptions.method).toBe('PUT');
    const representation = JSON.parse(String(updateOptions.body)) as Record<string, unknown>;
    expect(representation).toMatchObject({
      displayName: 'Preserve me',
      smtpServer: { host: 'mail.internal' },
      accessTokenLifespan: 300,
      ssoSessionIdleTimeout: 604_800,
      ssoSessionMaxLifespan: 2_592_000,
      clientSessionIdleTimeout: 604_800,
      clientSessionMaxLifespan: 2_592_000,
    });
  });
});
