import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { loadRuntimeConfig } from '../config/runtime-config';
import { AppError } from '../common/errors';
import { CurrentPrincipal } from './auth.decorators';
import type { AuthenticatedPrincipal } from './auth.types';
import { KeycloakJwtGuard } from './keycloak-jwt.guard';
import { sanitizeReturnTo } from './return-to';
import { parseCookies, SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  private readonly config = loadRuntimeConfig();

  constructor(private readonly sessions: SessionService) {}

  @Get('login')
  async login(
    @Query('returnTo') requestedReturnTo: string | undefined,
    @Query('locale') requestedLocale: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!this.config.oidcIssuerUrl)
      throw new AppError('provider_unavailable', 503, 'Authentication service is unavailable.');
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.sessions.createLoginFlow(state, {
      verifier,
      nonce,
      returnTo: sanitizeReturnTo(requestedReturnTo),
    });
    reply.header('set-cookie', oidcStateCookie(state, this.config.publicBaseUrl));
    const url = new URL(`${this.config.oidcIssuerUrl}/protocol/openid-connect/auth`);
    url.search = new URLSearchParams({
      client_id: this.config.oidcClientId,
      redirect_uri: `${this.config.publicBaseUrl}/auth/callback`,
      response_type: 'code',
      scope: 'openid profile email',
      prompt: 'login',
      ui_locales: requestedLocale === 'en' ? 'en' : 'zh-TW',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    await reply.code(302).redirect(url.toString());
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const cookieState = parseCookies(request.headers.cookie).swr_oidc_state;
    if (!code || !state || !cookieState || state !== cookieState) {
      throw new AppError('authentication_error', 401);
    }
    const flow = await this.sessions.consumeLoginFlow(state);
    if (!flow) throw new AppError('authentication_error', 401);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.oidcClientId,
      redirect_uri: `${this.config.publicBaseUrl}/auth/callback`,
      code,
      code_verifier: flow.verifier,
    });
    if (this.config.oidcClientSecret) body.set('client_secret', this.config.oidcClientSecret);
    const response = await fetch(this.config.oidcTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    }).catch((error: unknown) => {
      throw new AppError(
        'provider_unavailable',
        503,
        'Authentication service is unavailable.',
        null,
        error,
      );
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('authentication_error', 401);
    }
    const tokens = (await response.json()) as Record<string, unknown>;
    if (typeof tokens.access_token !== 'string') throw new AppError('authentication_error', 401);
    const expiresIn = Number(tokens.expires_in ?? 300);
    const refreshExpiresIn = Number(tokens.refresh_expires_in ?? expiresIn);
    const now = Date.now();
    const sessionId = await this.sessions.createSession({
      accessToken: tokens.access_token,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
      idToken: typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
      expiresAt: now + Math.max(60, expiresIn) * 1000,
      refreshExpiresAt: now + Math.max(60, refreshExpiresIn) * 1000,
      absoluteExpiresAt: now + this.config.authSessionMaxSeconds * 1000,
    });
    reply.headers({
      'set-cookie': [
        clearOidcStateCookie(this.config.publicBaseUrl),
        sessionCookie(sessionId, this.config.publicBaseUrl, this.config.authSessionMaxSeconds),
      ],
      'cache-control': 'no-store',
    });
    await reply
      .code(302)
      .redirect(`${this.config.publicBaseUrl}${sanitizeReturnTo(flow.returnTo)}`);
  }

  @Get('logout')
  async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const sessionId = parseCookies(request.headers.cookie).swr_session;
    if (sessionId) await this.sessions.deleteSession(sessionId);
    reply.header('set-cookie', clearSessionCookie(this.config.publicBaseUrl));
    reply.header('cache-control', 'no-store');
    await reply.code(302).redirect(`${this.config.publicBaseUrl}/`);
  }

  @Get('session')
  @UseGuards(KeycloakJwtGuard)
  session(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return {
      authenticated: true,
      user: { id: principal.userId, email: principal.email, role: principal.role },
    };
  }

  @Get('config')
  browserConfig() {
    return { loginUrl: '/auth/login', logoutUrl: '/auth/logout', sessionUrl: '/auth/session' };
  }
}

function cookieSecurity(baseUrl: string): string {
  return baseUrl.startsWith('https:') ? '; Secure' : '';
}

function oidcStateCookie(value: string, baseUrl: string): string {
  return `swr_oidc_state=${encodeURIComponent(value)}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${cookieSecurity(baseUrl)}`;
}

function clearOidcStateCookie(baseUrl: string): string {
  return `swr_oidc_state=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(baseUrl)}`;
}

function sessionCookie(value: string, baseUrl: string, maxAgeSeconds: number): string {
  return `swr_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieSecurity(baseUrl)}`;
}

function clearSessionCookie(baseUrl: string): string {
  return `swr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(baseUrl)}`;
}
