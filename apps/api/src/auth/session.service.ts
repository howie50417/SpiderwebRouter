import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { loadRuntimeConfig } from '../config/runtime-config';

interface BrowserSession {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  refreshExpiresAt?: number;
}

interface LoginFlow {
  verifier: string;
  nonce: string;
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
    const ttl = this.sessionTtl(session);
    await this.redis.set(`browser-session:${id}`, JSON.stringify(session), 'EX', ttl);
    return id;
  }

  async getSession(id: string): Promise<BrowserSession | undefined> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(id)) return undefined;
    await this.ensureConnected();
    const value = await this.redis.get(`browser-session:${id}`);
    if (!value) return undefined;
    const session = JSON.parse(value) as BrowserSession;
    if (session.expiresAt > Date.now() + 15_000) return session;
    if (
      !session.refreshToken ||
      (session.refreshExpiresAt && session.refreshExpiresAt <= Date.now())
    ) {
      await this.deleteSession(id);
      return undefined;
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
        await response.body?.cancel();
        await this.deleteSession(id);
        return undefined;
      }
      const tokens = (await response.json()) as Record<string, unknown>;
      if (typeof tokens.access_token !== 'string') {
        await this.deleteSession(id);
        return undefined;
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
      };
      await this.redis.set(
        `browser-session:${id}`,
        JSON.stringify(refreshed),
        'EX',
        this.sessionTtl(refreshed),
      );
      return refreshed;
    } catch {
      await this.deleteSession(id).catch(() => undefined);
      return undefined;
    }
  }

  private sessionTtl(session: BrowserSession): number {
    const end = session.refreshExpiresAt ?? session.expiresAt;
    return Math.max(60, Math.min(86_400, Math.floor((end - Date.now()) / 1000)));
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
