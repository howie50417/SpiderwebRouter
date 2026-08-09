import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { AppError } from '../common/errors';
import { loadRuntimeConfig } from '../config/runtime-config';

export interface BrowserSession {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  refreshExpiresAt?: number;
  absoluteExpiresAt: number;
}

export interface LoginFlow {
  verifier: string;
  nonce: string;
  returnTo: string;
}

@Injectable()
export class SessionService implements OnModuleDestroy {
  private readonly config = loadRuntimeConfig();
  private readonly redis = new Redis(this.config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  async createLoginFlow(state: string, flow: LoginFlow): Promise<void> {
    await this.ensureConnected();
    await this.redis.set(`oidc-flow:${state}`, JSON.stringify(flow), 'EX', 600);
  }

  async consumeLoginFlow(state: string): Promise<LoginFlow | undefined> {
    await this.ensureConnected();
    const key = `oidc-flow:${state}`;
    const value = await this.redis.get(key);
    if (!value) return undefined;
    await this.redis.del(key);
    return JSON.parse(value) as LoginFlow;
  }

  async createSession(session: BrowserSession): Promise<string> {
    await this.ensureConnected();
    const id = randomBytes(32).toString('base64url');
    const now = Date.now();
    const storedSession = {
      ...session,
      absoluteExpiresAt: Math.min(
        session.absoluteExpiresAt,
        now + this.config.authSessionMaxSeconds * 1000,
      ),
    };
    const ttl = this.sessionTtl(storedSession, now);
    if (ttl <= 0) throw new AppError('authentication_error', 401);
    await this.redis.set(`browser-session:${id}`, JSON.stringify(storedSession), 'EX', ttl);
    return id;
  }

  async getSession(id: string): Promise<BrowserSession | undefined> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(id)) return undefined;
    await this.ensureConnected();
    const value = await this.redis.get(`browser-session:${id}`);
    if (!value) return undefined;
    const session = JSON.parse(value) as BrowserSession;
    const now = Date.now();
    // Sessions created before absolute expiry was introduced are intentionally
    // invalidated once instead of receiving a fresh 30-day window.
    if (!Number.isFinite(session.absoluteExpiresAt) || session.absoluteExpiresAt <= now) {
      await this.deleteSession(id);
      return undefined;
    }
    if (!session.refreshToken || (session.refreshExpiresAt && session.refreshExpiresAt <= now)) {
      if (session.expiresAt <= now + 15_000) {
        await this.deleteSession(id);
        return undefined;
      }
    }
    if (session.expiresAt > now + 15_000) {
      await this.touchSession(id, session, now);
      return session;
    }
    return this.refreshSession(id, session);
  }

  async deleteSession(id: string): Promise<void> {
    await this.ensureConnected();
    await this.redis.del(`browser-session:${id}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status !== 'end') this.redis.disconnect();
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
  }

  private async refreshSession(
    id: string,
    session: BrowserSession,
  ): Promise<BrowserSession | undefined> {
    if (session.absoluteExpiresAt <= Date.now()) {
      await this.deleteSession(id);
      return undefined;
    }
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken!,
        client_id: this.config.oidcClientId,
      });
      if (this.config.oidcClientSecret) body.set('client_secret', this.config.oidcClientSecret);
      const response = await fetch(this.config.oidcTokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const failure = await readTokenFailure(response);
        if (failure === 'invalid_grant') {
          await this.deleteSession(id);
          return undefined;
        }
        throw new AppError(
          'provider_unavailable',
          503,
          'Authentication service is temporarily unavailable.',
          null,
          { status: response.status, error: failure },
        );
      }
      const tokens = (await response.json()) as Record<string, unknown>;
      if (typeof tokens.access_token !== 'string') {
        throw new AppError(
          'provider_unavailable',
          503,
          'Authentication service is temporarily unavailable.',
          null,
          { error: 'invalid_token_response' },
        );
      }
      const now = Date.now();
      const refreshed: BrowserSession = {
        accessToken: tokens.access_token,
        refreshToken:
          typeof tokens.refresh_token === 'string' ? tokens.refresh_token : session.refreshToken,
        idToken: typeof tokens.id_token === 'string' ? tokens.id_token : session.idToken,
        expiresAt: now + Math.max(60, Number(tokens.expires_in ?? 300)) * 1000,
        refreshExpiresAt:
          tokens.refresh_expires_in === undefined
            ? session.refreshExpiresAt
            : now + Math.max(60, Number(tokens.refresh_expires_in)) * 1000,
        absoluteExpiresAt: session.absoluteExpiresAt,
      };
      const ttl = this.sessionTtl(refreshed, now);
      if (ttl <= 0) {
        await this.deleteSession(id);
        return undefined;
      }
      await this.redis.set(`browser-session:${id}`, JSON.stringify(refreshed), 'EX', ttl);
      return refreshed;
    } catch (error) {
      if (error instanceof AppError) throw error;
      const isTimeout =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new AppError(
        isTimeout ? 'upstream_timeout' : 'provider_unavailable',
        isTimeout ? 504 : 503,
        isTimeout
          ? 'Authentication service timed out.'
          : 'Authentication service is temporarily unavailable.',
        null,
        error,
      );
    }
  }

  private async touchSession(id: string, session: BrowserSession, now: number): Promise<void> {
    const ttl = this.sessionTtl(session, now);
    if (ttl <= 0) {
      await this.deleteSession(id);
      return;
    }
    await this.redis.expire(`browser-session:${id}`, ttl);
  }

  private sessionTtl(session: BrowserSession, now = Date.now()): number {
    return sessionTtlSeconds(
      session,
      now,
      this.config.authSessionIdleSeconds,
      this.config.authSessionMaxSeconds,
    );
  }
}

export function sessionTtlSeconds(
  session: BrowserSession,
  now: number,
  idleSeconds: number,
  maximumSeconds: number,
): number {
  const configuredEnd = now + maximumSeconds * 1000;
  const credentialEnd = session.refreshToken
    ? (session.refreshExpiresAt ?? session.absoluteExpiresAt)
    : session.expiresAt;
  const end = Math.min(session.absoluteExpiresAt, credentialEnd, configuredEnd);
  return Math.max(0, Math.min(idleSeconds, Math.floor((end - now) / 1000)));
}

async function readTokenFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    return typeof body.error === 'string' ? body.error : 'token_endpoint_error';
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return 'token_endpoint_error';
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const index = part.indexOf('=');
      if (index < 0) return [];
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      try {
        return [[key, decodeURIComponent(value)]];
      } catch {
        return [];
      }
    }),
  );
}
