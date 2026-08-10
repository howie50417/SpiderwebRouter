import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../src/auth/auth.controller';
import { KeycloakJwtGuard } from '../src/auth/keycloak-jwt.guard';
import { SessionService } from '../src/auth/session.service';
import { loadRuntimeConfig } from '../src/config/runtime-config';

const sessions = {
  createLoginFlow: vi.fn(async () => undefined),
  consumeLoginFlow: vi.fn(),
  createSession: vi.fn(async () => 'browser-session-id-that-is-long-enough'),
  deleteSession: vi.fn(async () => undefined),
};

Reflect.defineMetadata('design:paramtypes', [SessionService], AuthController);

@Module({
  controllers: [AuthController],
  providers: [
    { provide: SessionService, useValue: sessions },
    { provide: KeycloakJwtGuard, useValue: { canActivate: () => true } },
  ],
})
class AuthRedirectTestModule {}

describe('OIDC browser redirects', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?schema=app';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.API_KEY_PEPPER = 'test-api-key-pepper';
    process.env.PROVIDER_ENCRYPTION_KEY = 'test-provider-encryption-key';
    process.env.PUBLIC_BASE_URL = 'https://router.example.test';
    process.env.OIDC_ISSUER_URL = 'https://router.example.test/auth/realms/spiderwebrouter';
    process.env.OIDC_CLIENT_ID = 'spiderwebrouter-web';
    process.env.AUTH_SESSION_IDLE_SECONDS = '604800';
    process.env.AUTH_SESSION_MAX_SECONDS = '2592000';
    loadRuntimeConfig({ refresh: true });

    app = await NestFactory.create<NestFastifyApplication>(
      AuthRedirectTestModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an actual 302 to Keycloak instead of an empty 200 document', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/auth/login?returnTo=%2Fusage%3Fstatus%3DFAILED%23attempts',
    });

    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toMatch(
      /^https:\/\/router\.example\.test\/auth\/realms\/spiderwebrouter\/protocol\/openid-connect\/auth\?/,
    );
    expect(new URL(String(response.headers.location)).searchParams.get('ui_locales')).toBe('zh-TW');
    expect(response.headers['set-cookie']).toContain('swr_oidc_state=');
    expect(response.headers['set-cookie']).toContain('Secure');
    expect(sessions.createLoginFlow).toHaveBeenCalledOnce();
    expect(sessions.createLoginFlow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ returnTo: '/usage?status=FAILED#attempts' }),
    );
  });

  it('passes an explicitly selected English locale to Keycloak', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/auth/login?locale=en',
    });

    expect(response.statusCode, response.body).toBe(302);
    expect(new URL(String(response.headers.location)).searchParams.get('ui_locales')).toBe('en');
  });

  it('returns to the server-stored internal route after callback', async () => {
    sessions.consumeLoginFlow.mockResolvedValueOnce({
      verifier: 'pkce-verifier',
      nonce: 'oidc-nonce',
      returnTo: '/usage?status=FAILED#attempts',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 300,
            refresh_expires_in: 2592000,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/auth/callback?code=authorization-code&state=matching-state',
        headers: { cookie: 'swr_oidc_state=matching-state' },
      });

    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toBe(
      'https://router.example.test/usage?status=FAILED#attempts',
    );
    expect(JSON.stringify(response.headers['set-cookie'])).toContain('Max-Age=2592000');
    expect(sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        absoluteExpiresAt: expect.any(Number),
      }),
    );
  });

  it('falls back to the home page for a legacy login flow without returnTo', async () => {
    sessions.consumeLoginFlow.mockResolvedValueOnce({
      verifier: 'legacy-pkce-verifier',
      nonce: 'legacy-oidc-nonce',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 300,
            refresh_expires_in: 2592000,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/auth/callback?code=authorization-code&state=legacy-state',
        headers: { cookie: 'swr_oidc_state=legacy-state' },
      });

    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toBe('https://router.example.test/');
  });

  it('returns an actual 302 when logging out', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/auth/logout',
        headers: { cookie: 'swr_session=test-session-id-that-is-long-enough' },
      });

    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toBe('https://router.example.test/');
    expect(response.headers['set-cookie']).toContain('swr_session=;');
  });
});
