import type { ExecutionContext } from '@nestjs/common';
import { Prisma, UserRole, type User } from '@prisma/client';
import type { JWTPayload } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeycloakJwtGuard } from '../src/auth/keycloak-jwt.guard';
import type { AuthenticatedPrincipal } from '../src/auth/auth.types';
import type { SessionService } from '../src/auth/session.service';
import { loadRuntimeConfig } from '../src/config/runtime-config';
import type { PrismaService } from '../src/database/prisma.service';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'existing-user',
    keycloakSubject: 'existing-subject',
    email: 'existing@example.com',
    displayName: 'Existing User',
    role: UserRole.SUPER_ADMIN,
    active: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function uniqueConflict() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

interface UserFilter {
  id?: string;
  keycloakSubject?: string;
  email?: string;
  OR?: UserFilter[];
}

function harness(initialUsers: User[], claims: JWTPayload) {
  const users = initialUsers.map((user) => ({ ...user }));
  const matches = (user: User, where: UserFilter): boolean =>
    where.OR
      ? where.OR.some((filter) => matches(user, filter))
      : Object.entries(where).every(([key, value]) => user[key as keyof User] === value);
  const find = async ({ where }: { where: UserFilter }) =>
    users.find((user) => matches(user, where)) ?? null;
  const userStore = {
    findUnique: vi.fn(find),
    findFirst: vi.fn(find),
    create: vi.fn(async ({ data }: { data: Partial<User> }) => {
      if (
        users.some(
          (user) => user.email === data.email || user.keycloakSubject === data.keycloakSubject,
        )
      ) {
        throw uniqueConflict();
      }
      const user = makeUser({ id: 'created-user', role: UserRole.USER, ...data });
      users.push(user);
      return user;
    }),
    update: vi.fn(async ({ where, data }: { where: UserFilter; data: Partial<User> }) => {
      const user = users.find((candidate) => matches(candidate, where));
      if (!user) throw new Error('User was not found');
      Object.assign(user, data);
      return user;
    }),
  };
  const sessions = { getSession: vi.fn().mockResolvedValue({ accessToken: 'session-token' }) };
  const guard = new KeycloakJwtGuard(
    { user: userStore } as unknown as PrismaService,
    sessions as unknown as SessionService,
  );
  vi.spyOn(
    guard as unknown as { verify(token: string): Promise<JWTPayload> },
    'verify',
  ).mockResolvedValue({ azp: 'spiderwebrouter', ...claims });
  const request: {
    headers: { authorization?: string; cookie?: string };
    principal?: AuthenticatedPrincipal;
  } = { headers: { authorization: 'Bearer test-token' } };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard, context, request, users, userStore, sessions };
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost/test');
  vi.stubEnv('API_KEY_PEPPER', 'test-pepper');
  vi.stubEnv('PROVIDER_ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('OIDC_ISSUER_URL', 'https://keycloak.test/realms/spiderwebrouter');
  vi.stubEnv('OIDC_CLIENT_ID', 'spiderwebrouter');
  vi.stubEnv('OIDC_AUDIENCE', '');
  loadRuntimeConfig({ refresh: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Keycloak account binding', () => {
  it.each([true, false])(
    'rejects a different subject claiming an existing admin email (verified=%s)',
    async (emailVerified) => {
      const { guard, context, request, users, userStore } = harness([makeUser()], {
        sub: 'different-subject',
        email: 'EXISTING@example.com',
        email_verified: emailVerified,
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        code: 'authentication_error',
        statusCode: 401,
      });
      expect(request.principal).toBeUndefined();
      expect(users).toEqual([makeUser()]);
      expect(userStore.update).not.toHaveBeenCalled();
    },
  );

  it.each([null, 'bootstrap:existing@example.com'])(
    'does not automatically claim a legacy account with subject %s',
    async (keycloakSubject) => {
      const { guard, context, request, users } = harness([makeUser({ keycloakSubject })], {
        sub: 'different-subject',
        email: 'existing@example.com',
        email_verified: true,
      });

      await expect(guard.canActivate(context)).rejects.toMatchObject({ statusCode: 401 });
      expect(request.principal).toBeUndefined();
      expect(users[0]?.keycloakSubject).toBe(keycloakSubject);
    },
  );

  it('keeps the subject owner when a changed email matches another admin', async () => {
    const ownUser = makeUser({
      id: 'own-user',
      keycloakSubject: 'own-subject',
      email: 'own@example.com',
      role: UserRole.USER,
    });
    const { guard, context, request, userStore } = harness([makeUser(), ownUser], {
      sub: 'own-subject',
      email: 'existing@example.com',
      email_verified: false,
      realm_access: { roles: ['SUPER_ADMIN'] },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.principal).toEqual({
      userId: 'own-user',
      subject: 'own-subject',
      email: 'own@example.com',
      role: UserRole.USER,
    });
    expect(userStore.create).not.toHaveBeenCalled();
    expect(userStore.update).not.toHaveBeenCalled();
  });

  it('allows a pre-provisioned admin with its exact subject', async () => {
    const { guard, context, request } = harness([makeUser()], {
      sub: 'existing-subject',
      email: 'existing@example.com',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.principal).toMatchObject({
      userId: 'existing-user',
      role: UserRole.SUPER_ADMIN,
    });
  });

  it('creates a new account bound to its own subject', async () => {
    const { guard, context, request, users } = harness([], {
      sub: 'new-subject',
      email: 'NEW@example.com',
      name: 'New User',
      realm_access: { roles: ['USER'] },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      keycloakSubject: 'new-subject',
      email: 'new@example.com',
      displayName: 'New User',
      role: UserRole.USER,
    });
    expect(request.principal).toMatchObject({ subject: 'new-subject', role: UserRole.USER });
  });

  it('enforces subject binding for browser sessions as well as bearer tokens', async () => {
    const { guard, context, request, sessions } = harness([makeUser()], {
      sub: 'different-subject',
      email: 'existing@example.com',
    });
    request.headers = { cookie: 'swr_session=test-session' };

    await expect(guard.canActivate(context)).rejects.toMatchObject({ statusCode: 401 });
    expect(sessions.getSession).toHaveBeenCalledWith('test-session');
    expect(request.principal).toBeUndefined();
  });

  it('recovers a concurrent first login only through the same subject', async () => {
    const { guard, context, request, users, userStore } = harness([], {
      sub: 'new-subject',
      email: 'new@example.com',
    });
    userStore.create.mockImplementationOnce(async () => {
      users.push(
        makeUser({
          id: 'concurrently-created',
          keycloakSubject: 'new-subject',
          email: 'new@example.com',
          role: UserRole.USER,
        }),
      );
      throw uniqueConflict();
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.principal).toMatchObject({
      userId: 'concurrently-created',
      subject: 'new-subject',
      role: UserRole.USER,
    });
  });

  it('rejects an email collision created during first login', async () => {
    const { guard, context, request, users, userStore } = harness([], {
      sub: 'new-subject',
      email: 'existing@example.com',
    });
    userStore.create.mockImplementationOnce(async () => {
      users.push(makeUser());
      throw uniqueConflict();
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ statusCode: 401 });
    expect(request.principal).toBeUndefined();
    expect(users[0]?.keycloakSubject).toBe('existing-subject');
  });

  it('continues rejecting disabled accounts', async () => {
    const { guard, context, request } = harness([makeUser({ active: false })], {
      sub: 'existing-subject',
      email: 'existing@example.com',
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'permission_denied',
      statusCode: 403,
    });
    expect(request.principal).toBeUndefined();
  });

  it('does not turn database outages into invalid credential errors', async () => {
    const { guard, context, userStore } = harness([], {
      sub: 'new-subject',
      email: 'new@example.com',
    });
    const outage = new Prisma.PrismaClientKnownRequestError('Database is unavailable', {
      code: 'P1001',
      clientVersion: 'test',
    });
    userStore.create.mockRejectedValueOnce(outage);

    await expect(guard.canActivate(context)).rejects.toBe(outage);
  });
});
