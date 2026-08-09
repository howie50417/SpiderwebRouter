import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '@/api/client';
import {
  registerIdentityReset,
  resetUnauthorizedRedirectForTests,
  setUnauthorizedNavigationForTests,
} from '@/auth/sessionExpiry';

afterEach(() => {
  vi.unstubAllGlobals();
  resetUnauthorizedRedirectForTests();
});

describe('apiClient', () => {
  it('sends same-origin credentialed JSON requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      apiClient.post('/admin/providers', { name: 'Provider', enabled: true }),
    ).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/providers');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(String(options.body))).toMatchObject({
      name: 'Provider',
      active: true,
    });
    expect(new Headers(options.headers).get('X-Requested-With')).toBe('SpiderwebRouterConsole');
  });

  it('never exposes an unrecognized server error body', async () => {
    const leakedMessage = 'Bearer secret-token failed at private-provider.example';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: leakedMessage }), {
          status: 502,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req_safe_123',
          },
        }),
      ),
    );

    const error = (await apiClient
      .get('/admin/dashboard')
      .catch((reason: unknown) => reason)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).not.toContain(leakedMessage);
    expect(error.code).toBe('internal_error');
    expect(error.requestId).toBe('req_safe_123');
  });

  it('accepts the OpenAI-compatible safe error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'The upstream timed out.',
              type: 'invalid_request_error',
              code: 'upstream_timeout',
              param: null,
              request_id: 'req_timeout_1',
            },
          }),
          { status: 504, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const error = (await apiClient
      .get('/admin/dashboard')
      .catch((reason: unknown) => reason)) as ApiError;
    expect(error).toMatchObject({
      code: 'upstream_timeout',
      requestId: 'req_timeout_1',
    });
    expect(error.message).toBe('The model service took too long to respond.');
  });

  it('clears identity and starts only one login redirect for repeated 401 responses', async () => {
    const resetIdentity = vi.fn();
    const navigate = vi.fn();
    registerIdentityReset(resetIdentity);
    setUnauthorizedNavigationForTests(navigate);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'authentication_error', request_id: 'expired-session' },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await Promise.allSettled([
      apiClient.get('/admin/dashboard'),
      apiClient.download('/me/usage.csv'),
    ]);

    expect(resetIdentity).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('/login?returnTo=%2F&reason=expired');
  });

  it('normalizes array responses and backend field names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: 'provider-1',
              name: 'Local',
              type: 'GENERIC_OPENAI',
              active: true,
              hasSecret: true,
              _count: { discoveredModels: 4 },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const result = await apiClient.list<Record<string, unknown>>('/admin/providers');
    expect(result.total).toBe(1);
    expect(result.data[0]).toMatchObject({
      type: 'OPENAI_COMPATIBLE',
      enabled: true,
      secretConfigured: true,
      discoveredModelCount: 4,
    });
  });

  it('filters and paginates legacy array list responses locally', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { id: '1', name: 'First OpenAI', type: 'OPENAI', active: true },
            { id: '2', name: 'Disabled OpenAI', type: 'OPENAI', active: false },
            { id: '3', name: 'Second OpenAI', type: 'OPENAI', active: true },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const result = await apiClient.list<Record<string, unknown>>('/admin/providers', {
      enabled: true,
      search: 'openai',
      page: 2,
      pageSize: 1,
    });

    expect(result.total).toBe(2);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe('3');
  });
});
