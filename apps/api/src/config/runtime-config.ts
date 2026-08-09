import { readFileSync } from 'node:fs';

export interface RuntimeConfig {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  apiKeyPepper: string;
  providerEncryptionKey: string;
  sessionSecret: string;
  oidcIssuerUrl: string;
  oidcJwksUrl: string;
  oidcTokenUrl: string;
  keycloakBaseUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcAudience?: string;
  publicBaseUrl: string;
  authSessionIdleSeconds: number;
  authSessionMaxSeconds: number;
  allowedHttpHosts: string[];
  logLevel: string;
}

let cached: RuntimeConfig | undefined;

export function readSecret(name: string, fallback = ''): string {
  const file = process.env[`${name}_FILE`];
  if (file) {
    return readFileSync(file, 'utf8').trim();
  }
  return (process.env[name] ?? fallback).trim();
}

function databaseUrl(): string {
  const direct = readSecret('DATABASE_URL');
  if (direct) return direct;
  const user = process.env.POSTGRES_USER ?? 'spiderweb';
  const password = readSecret('POSTGRES_PASSWORD');
  const host = process.env.POSTGRES_HOST ?? 'postgres';
  const port = process.env.POSTGRES_PORT ?? '5432';
  const database = process.env.POSTGRES_DB ?? 'spiderwebrouter';
  if (!password) return '';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}?schema=app`;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function redisUrl(): string {
  const direct = process.env.REDIS_URL?.trim();
  if (direct) return direct;
  const password = readSecret('REDIS_PASSWORD');
  const host = process.env.REDIS_HOST ?? 'redis';
  const port = process.env.REDIS_PORT ?? '6379';
  return password
    ? `redis://:${encodeURIComponent(password)}@${host}:${port}`
    : `redis://${host}:${port}`;
}

export function loadRuntimeConfig(
  options: { validate?: boolean; refresh?: boolean } = {},
): RuntimeConfig {
  if (cached && !options.refresh) return cached;
  const oidcIssuerUrl = (process.env.OIDC_ISSUER_URL ?? '').replace(/\/$/, '');
  const realmMatch = /\/realms\/([^/]+)$/.exec(oidcIssuerUrl);
  const internalBase = (process.env.KEYCLOAK_BASE_URL ?? '').replace(/\/$/, '');
  const internalRealm = internalBase && realmMatch ? `${internalBase}/realms/${realmMatch[1]}` : '';
  const authSessionIdleSeconds = positiveInteger('AUTH_SESSION_IDLE_SECONDS', 604_800);
  const authSessionMaxSeconds = positiveInteger('AUTH_SESSION_MAX_SECONDS', 2_592_000);
  if (authSessionIdleSeconds > authSessionMaxSeconds) {
    throw new Error('AUTH_SESSION_IDLE_SECONDS must not exceed AUTH_SESSION_MAX_SECONDS');
  }
  const config: RuntimeConfig = {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: positiveInteger('PORT', 3000),
    databaseUrl: databaseUrl(),
    redisUrl: redisUrl(),
    apiKeyPepper: readSecret('API_KEY_PEPPER'),
    providerEncryptionKey: readSecret('PROVIDER_ENCRYPTION_KEY'),
    sessionSecret: readSecret('SESSION_SECRET'),
    oidcIssuerUrl,
    oidcJwksUrl:
      process.env.OIDC_JWKS_URL ??
      (internalRealm
        ? `${internalRealm}/protocol/openid-connect/certs`
        : `${oidcIssuerUrl}/protocol/openid-connect/certs`),
    oidcTokenUrl:
      process.env.OIDC_TOKEN_URL ??
      (internalRealm
        ? `${internalRealm}/protocol/openid-connect/token`
        : `${oidcIssuerUrl}/protocol/openid-connect/token`),
    keycloakBaseUrl: internalBase || oidcIssuerUrl.replace(/\/realms\/[^/]+$/, ''),
    oidcClientId: process.env.OIDC_CLIENT_ID ?? 'spiderwebrouter',
    oidcClientSecret: readSecret('OIDC_CLIENT_SECRET') || readSecret('KEYCLOAK_CLIENT_SECRET'),
    oidcAudience: process.env.OIDC_AUDIENCE || undefined,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost').replace(/\/$/, ''),
    authSessionIdleSeconds,
    authSessionMaxSeconds,
    allowedHttpHosts: (process.env.ALLOWED_HTTP_HOSTS ?? 'ollama,open-webui')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };

  process.env.DATABASE_URL = config.databaseUrl;
  if (options.validate !== false) validateRuntimeConfig(config);
  cached = config;
  return config;
}

export function validateRuntimeConfig(config: RuntimeConfig): void {
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL or POSTGRES_PASSWORD(_FILE)');
  if (!config.apiKeyPepper) missing.push('API_KEY_PEPPER(_FILE)');
  if (!config.providerEncryptionKey) missing.push('PROVIDER_ENCRYPTION_KEY(_FILE)');
  if (config.nodeEnv === 'production' && !config.oidcIssuerUrl) missing.push('OIDC_ISSUER_URL');
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
}
