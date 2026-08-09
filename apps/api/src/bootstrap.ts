import 'reflect-metadata';
import { PrismaClient, UserRole } from '@prisma/client';
import { loadRuntimeConfig, readSecret } from './config/runtime-config';
import { appLogger } from './common/logger';

type JsonObject = Record<string, unknown>;

export async function bootstrap(): Promise<void> {
  const config = loadRuntimeConfig({ refresh: true });
  const adminEmail = (process.env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const adminPassword = readSecret('INITIAL_ADMIN_PASSWORD');
  const keycloakAdminUsername = process.env.KEYCLOAK_ADMIN_USERNAME ?? 'admin';
  const keycloakAdminPassword = readSecret('KEYCLOAK_ADMIN_PASSWORD');
  const clientSecret = config.oidcClientSecret;
  const realm = decodeURIComponent(
    /\/realms\/([^/]+)$/.exec(config.oidcIssuerUrl)?.[1] ?? 'spiderwebrouter',
  );
  const missing = [
    !adminEmail && 'INITIAL_ADMIN_EMAIL',
    !adminPassword && 'INITIAL_ADMIN_PASSWORD(_FILE)',
    !keycloakAdminPassword && 'KEYCLOAK_ADMIN_PASSWORD(_FILE)',
    !clientSecret && 'KEYCLOAK_CLIENT_SECRET(_FILE)',
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing bootstrap configuration: ${missing.join(', ')}`);

  const adminToken = await keycloakAdminToken(
    config.keycloakBaseUrl,
    keycloakAdminUsername,
    keycloakAdminPassword,
  );
  await ensureRealm(
    config.keycloakBaseUrl,
    realm,
    adminToken,
    config.authSessionIdleSeconds,
    config.authSessionMaxSeconds,
  );
  await ensureRealmRole(config.keycloakBaseUrl, realm, 'USER', adminToken);
  await ensureRealmRole(config.keycloakBaseUrl, realm, 'ADMIN', adminToken);
  const superAdminRole = await ensureRealmRole(
    config.keycloakBaseUrl,
    realm,
    'SUPER_ADMIN',
    adminToken,
  );
  await ensureClient(
    config.keycloakBaseUrl,
    realm,
    config.oidcClientId,
    clientSecret,
    config.publicBaseUrl,
    adminToken,
  );
  const keycloakUserId = await ensureInitialAdmin(
    config.keycloakBaseUrl,
    realm,
    adminEmail,
    adminPassword,
    superAdminRole,
    adminToken,
  );

  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    await prisma.user.upsert({
      where: { email: adminEmail },
      create: {
        email: adminEmail,
        keycloakSubject: keycloakUserId,
        displayName: 'Super Administrator',
        role: UserRole.SUPER_ADMIN,
        active: true,
      },
      update: { keycloakSubject: keycloakUserId, role: UserRole.SUPER_ADMIN, active: true },
    });
  } finally {
    await prisma.$disconnect();
  }
  appLogger.info({ realm, admin_email: adminEmail }, 'bootstrap_completed');
}

async function keycloakAdminToken(
  base: string,
  username: string,
  password: string,
): Promise<string> {
  const response = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username,
      password,
    }),
    redirect: 'error',
  });
  const body = (await response.json()) as JsonObject;
  if (!response.ok || typeof body.access_token !== 'string')
    throw new Error('Unable to authenticate to Keycloak Admin API');
  return body.access_token;
}

export async function ensureRealm(
  base: string,
  realm: string,
  token: string,
  sessionIdleSeconds: number,
  sessionMaxSeconds: number,
): Promise<void> {
  const path = `/admin/realms/${encodeURIComponent(realm)}`;
  const current = await keycloakRequest(base, path, token);
  const sessionSettings: JsonObject = {
    enabled: true,
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: true,
    rememberMe: true,
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: sessionIdleSeconds,
    ssoSessionMaxLifespan: sessionMaxSeconds,
    clientSessionIdleTimeout: sessionIdleSeconds,
    clientSessionMaxLifespan: sessionMaxSeconds,
  };
  if (current.status === 404) {
    await current.body?.cancel();
    await expectSuccess(
      await keycloakRequest(base, '/admin/realms', token, 'POST', {
        realm,
        ...sessionSettings,
      }),
      'create realm',
    );
  } else {
    await expectSuccess(current, 'read realm');
    const existing = (await current.json()) as JsonObject;
    await expectSuccess(
      await keycloakRequest(base, path, token, 'PUT', {
        ...existing,
        ...sessionSettings,
        realm,
      }),
      'update realm session settings',
    );
  }
}

async function ensureRealmRole(
  base: string,
  realm: string,
  name: string,
  token: string,
): Promise<JsonObject> {
  const path = `/admin/realms/${encodeURIComponent(realm)}/roles/${encodeURIComponent(name)}`;
  let response = await keycloakRequest(base, path, token);
  if (response.status === 404) {
    await expectSuccess(
      await keycloakRequest(
        base,
        `/admin/realms/${encodeURIComponent(realm)}/roles`,
        token,
        'POST',
        { name },
      ),
      `create role ${name}`,
    );
    response = await keycloakRequest(base, path, token);
  }
  await expectSuccess(response, `read role ${name}`);
  return response.json() as Promise<JsonObject>;
}

async function ensureClient(
  base: string,
  realm: string,
  clientId: string,
  secret: string,
  publicBaseUrl: string,
  token: string,
): Promise<void> {
  const collection = `/admin/realms/${encodeURIComponent(realm)}/clients`;
  const response = await keycloakRequest(
    base,
    `${collection}?clientId=${encodeURIComponent(clientId)}`,
    token,
  );
  await expectSuccess(response, 'find OIDC client');
  const clients = (await response.json()) as JsonObject[];
  const representation: JsonObject = {
    clientId,
    name: 'SpiderwebRouter',
    enabled: true,
    publicClient: false,
    secret,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: [`${publicBaseUrl}/auth/callback`],
    webOrigins: [publicBaseUrl],
    protocol: 'openid-connect',
    attributes: {
      'post.logout.redirect.uris': `${publicBaseUrl}/*`,
      'pkce.code.challenge.method': 'S256',
    },
  };
  const existing = clients[0];
  if (existing && typeof existing.id === 'string') {
    await expectSuccess(
      await keycloakRequest(
        base,
        `${collection}/${encodeURIComponent(existing.id)}`,
        token,
        'PUT',
        { ...existing, ...representation },
      ),
      'update OIDC client',
    );
  } else {
    await expectSuccess(
      await keycloakRequest(base, collection, token, 'POST', representation),
      'create OIDC client',
    );
  }
}

async function ensureInitialAdmin(
  base: string,
  realm: string,
  email: string,
  password: string,
  role: JsonObject,
  token: string,
): Promise<string> {
  const usersPath = `/admin/realms/${encodeURIComponent(realm)}/users`;
  let response = await keycloakRequest(
    base,
    `${usersPath}?exact=true&email=${encodeURIComponent(email)}`,
    token,
  );
  await expectSuccess(response, 'find initial administrator');
  let users = (await response.json()) as JsonObject[];
  if (!users.length) {
    await expectSuccess(
      await keycloakRequest(base, usersPath, token, 'POST', {
        username: email,
        email,
        emailVerified: true,
        enabled: true,
        totp: false,
        requiredActions: ['UPDATE_PASSWORD'],
        credentials: [{ type: 'password', value: password, temporary: true }],
      }),
      'create initial administrator',
    );
    response = await keycloakRequest(
      base,
      `${usersPath}?exact=true&email=${encodeURIComponent(email)}`,
      token,
    );
    await expectSuccess(response, 'read initial administrator');
    users = (await response.json()) as JsonObject[];
  }
  const id = users[0]?.id;
  if (typeof id !== 'string')
    throw new Error('Keycloak did not return the initial administrator ID');
  await expectSuccess(
    await keycloakRequest(
      base,
      `${usersPath}/${encodeURIComponent(id)}/role-mappings/realm`,
      token,
      'POST',
      [role],
    ),
    'assign SUPER_ADMIN role',
  );
  return id;
}

function keycloakRequest(
  base: string,
  path: string,
  token: string,
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
}

async function expectSuccess(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel();
  throw new Error(`Keycloak Admin API failed to ${action} (HTTP ${response.status})`);
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    appLogger.fatal({ err: error }, 'bootstrap_failed');
    process.exitCode = 1;
  });
}
