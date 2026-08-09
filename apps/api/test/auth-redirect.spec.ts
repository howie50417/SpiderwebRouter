import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../src/auth/auth.controller';
import { KeycloakJwtGuard } from '../src/auth/keycloak-jwt.guard';
import { SessionService } from '../src/auth/session.service';
import { loadRuntimeConfig } from '../src/config/runtime-config';

const sessions = {
  createLoginFlow: vi.fn(async () => undefined),
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
  });

  it('returns an actual 302 to Keycloak instead of an empty 200 document', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/auth/login?returnTo=%2F',
    });

    expect(response.statusCode, response.body).toBe(302);
    expect(response.headers.location).toMatch(
      /^https:\/\/router\.example\.test\/auth\/realms\/spiderwebrouter\/protocol\/openid-connect\/auth\?/,
    );
    expect(response.headers['set-cookie']).toContain('swr_oidc_state=');
    expect(response.headers['set-cookie']).toContain('Secure');
    expect(sessions.createLoginFlow).toHaveBeenCalledOnce();
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
