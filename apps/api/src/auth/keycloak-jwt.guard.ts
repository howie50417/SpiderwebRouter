import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { JWTVerifyResult, JWTPayload } from 'jose';
import { PrismaService } from '../database/prisma.service';
import { loadRuntimeConfig } from '../config/runtime-config';
import { AppError } from '../common/errors';
import type { AuthenticatedPrincipal } from './auth.types';
import { parseCookies, SessionService } from './session.service';

type JoseModule = typeof import('jose');
type RemoteJwkSet = ReturnType<JoseModule['createRemoteJWKSet']>;

@Injectable()
export class KeycloakJwtGuard implements CanActivate {
  private readonly config = loadRuntimeConfig();
  private jwks?: RemoteJwkSet;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { principal?: AuthenticatedPrincipal }>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/.exec(header.trim()) : null;
    let token = match?.[1];
    if (!token) {
      const sessionId = parseCookies(request.headers.cookie).swr_session;
      if (sessionId) token = (await this.sessions.getSession(sessionId))?.accessToken;
    }
    if (!token) throw new AppError('authentication_error', 401);

    const claims = await this.verify(token);
    if (!claims.sub || typeof claims.email !== 'string')
      throw new AppError('authentication_error', 401);
    if (!this.config.oidcAudience && !tokenTargetsClient(claims, this.config.oidcClientId)) {
      throw new AppError('authentication_error', 401);
    }
    const tokenRoles = this.roles(claims);
    const requestedRole =
      tokenRoles.includes('SUPER_ADMIN') || tokenRoles.includes('super_admin')
        ? 'SUPER_ADMIN'
        : tokenRoles.includes('ADMIN') || tokenRoles.includes('admin')
          ? 'ADMIN'
          : 'USER';
    // Email is mutable and must never link a token to another subject's account.
    let user = await this.prisma.user.findUnique({
      where: { keycloakSubject: claims.sub },
    });
    if (!user) {
      try {
        user = await this.prisma.user.create({
          data: {
            keycloakSubject: claims.sub,
            email: claims.email.toLowerCase(),
            displayName: typeof claims.name === 'string' ? claims.name : undefined,
            role: requestedRole,
          },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
        // Concurrent first logins may create this subject while we wait. An email
        // collision with any other account must fail without changing its binding.
        user = await this.prisma.user.findUnique({ where: { keycloakSubject: claims.sub } });
        if (!user) throw new AppError('authentication_error', 401);
      }
    }
    if (!user.active) throw new AppError('permission_denied', 403);
    request.principal = {
      userId: user.id,
      subject: claims.sub,
      email: user.email,
      role: user.role,
    };
    return true;
  }

  private async verify(token: string): Promise<JWTPayload> {
    if (!this.config.oidcIssuerUrl)
      throw new AppError('provider_unavailable', 503, 'Authentication service is unavailable.');
    try {
      const load = new Function('return import("jose")') as () => Promise<JoseModule>;
      const jose = await load();
      this.jwks ??= jose.createRemoteJWKSet(new URL(this.config.oidcJwksUrl));
      const options: Parameters<JoseModule['jwtVerify']>[2] = {
        issuer: this.config.oidcIssuerUrl,
        algorithms: ['RS256', 'ES256'],
      };
      if (this.config.oidcAudience) options.audience = this.config.oidcAudience;
      const verified: JWTVerifyResult = await jose.jwtVerify(token, this.jwks, options);
      return verified.payload;
    } catch (error) {
      throw mapJwtVerificationError(error);
    }
  }

  private roles(payload: JWTPayload): string[] {
    const realm = payload.realm_access as { roles?: string[] } | undefined;
    const clients = payload.resource_access as Record<string, { roles?: string[] }> | undefined;
    return [...(realm?.roles ?? []), ...(clients?.[this.config.oidcClientId]?.roles ?? [])];
  }
}

const INVALID_TOKEN_ERROR_CODES = new Set([
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWKS_NO_MATCHING_KEY',
]);

export function mapJwtVerificationError(error: unknown): AppError {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const name = error instanceof Error ? error.name : '';

  if (code === 'ERR_JWKS_TIMEOUT' || name === 'TimeoutError' || name === 'AbortError') {
    return new AppError('upstream_timeout', 504, 'Authentication service timed out.', null, error);
  }
  if (INVALID_TOKEN_ERROR_CODES.has(code)) {
    return new AppError('authentication_error', 401, undefined, null, error);
  }

  // Network failures, a non-200/malformed JWKS response, invalid provider
  // keys, and module/runtime failures are authentication-service outages.
  // They must never make the browser discard an otherwise valid session.
  return new AppError(
    'provider_unavailable',
    503,
    'Authentication service is temporarily unavailable.',
    null,
    error,
  );
}

export function tokenTargetsClient(payload: JWTPayload, clientId: string): boolean {
  if (payload.azp === clientId) return true;
  if (typeof payload.aud === 'string') return payload.aud === clientId;
  return Array.isArray(payload.aud) && payload.aud.includes(clientId);
}
