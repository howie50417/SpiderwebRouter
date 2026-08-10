import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureRealm } from '../src/bootstrap';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Keycloak realm settings', () => {
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
      loginTheme: 'spiderwebrouter',
      resetPasswordAllowed: false,
      internationalizationEnabled: true,
      supportedLocales: ['zh-TW', 'en'],
      defaultLocale: 'zh-TW',
      accessTokenLifespan: 300,
      ssoSessionIdleTimeout: 604_800,
      ssoSessionMaxLifespan: 2_592_000,
      clientSessionIdleTimeout: 604_800,
      clientSessionMaxLifespan: 2_592_000,
    });
  });

  it('creates a new realm with password recovery disabled and Traditional Chinese by default', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await ensureRealm(
      'https://keycloak.internal/auth',
      'spiderwebrouter',
      'admin-token',
      604_800,
      2_592_000,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [createUrl, createOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(createUrl).toBe('https://keycloak.internal/auth/admin/realms');
    expect(createOptions.method).toBe('POST');
    const representation = JSON.parse(String(createOptions.body)) as Record<string, unknown>;
    expect(representation).toMatchObject({
      realm: 'spiderwebrouter',
      loginTheme: 'spiderwebrouter',
      registrationAllowed: false,
      resetPasswordAllowed: false,
      internationalizationEnabled: true,
      supportedLocales: ['zh-TW', 'en'],
      defaultLocale: 'zh-TW',
    });
  });
});
