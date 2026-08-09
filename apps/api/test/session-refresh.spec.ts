import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  status: 'ready',
  connect: vi.fn(async () => undefined),
  get: vi.fn(),
  set: vi.fn(async () => 'OK'),
  del: vi.fn(async () => 1),
  expire: vi.fn(async () => 1),
  disconnect: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: class FakeRedis {
    status = redis.status;
    connect = redis.connect;
    get = redis.get;
    set = redis.set;
    del = redis.del;
    expire = redis.expire;
    disconnect = redis.disconnect;
  },
}));

import { AppError } from '../src/common/errors';
import { loadRuntimeConfig } from '../src/config/runtime-config';
import { SessionService } from '../src/auth/session.service';

describe('browser session refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?schema=app';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.API_KEY_PEPPER = 'test-api-key-pepper';
    process.env.PROVIDER_ENCRYPTION_KEY = 'test-provider-encryption-key';
    process.env.OIDC_ISSUER_URL = 'https://router.test/auth/realms/router';
    process.env.OIDC_TOKEN_URL = 'https://keycloak.test/token';
    process.env.AUTH_SESSION_IDLE_SECONDS = '604800';
    process.env.AUTH_SESSION_MAX_SECONDS = '2592000';
    loadRuntimeConfig({ refresh: true });
    const now = Date.now();
    redis.get.mockResolvedValue(
      JSON.stringify({
        accessToken: 'expired-access-token',
        refreshToken: 'refresh-token',
        expiresAt: now - 1,
        refreshExpiresAt: now + 604_800_000,
        absoluteExpiresAt: now + 2_592_000_000,
      }),
    );
  });

  it('deletes the session only when Keycloak reports invalid_grant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const service = new SessionService();

    await expect(service.getSession('a'.repeat(32))).resolves.toBeUndefined();
    expect(redis.del).toHaveBeenCalledWith(`browser-session:${'a'.repeat(32)}`);
  });

  it('preserves the session when Keycloak has a transient server error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const service = new SessionService();

    const error = await service.getSession('b'.repeat(32)).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'provider_unavailable', statusCode: 503 });
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('preserves the session and reports refresh timeouts separately', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')),
    );
    const service = new SessionService();

    const error = await service.getSession('c'.repeat(32)).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'upstream_timeout', statusCode: 504 });
    expect(redis.del).not.toHaveBeenCalled();
  });
});
