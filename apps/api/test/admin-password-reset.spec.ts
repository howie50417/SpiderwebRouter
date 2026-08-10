import { UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AdminController } from '../src/admin/admin.controller';
import { AdminService } from '../src/admin/admin.service';
import { REQUIRED_ROLES } from '../src/auth/auth.decorators';
import type { AuthenticatedPrincipal } from '../src/auth/auth.types';
import { KeycloakAdminService } from '../src/auth/keycloak-admin.service';
import { AppError } from '../src/common/errors';

const actor: AuthenticatedPrincipal = {
  userId: '11111111-1111-4111-8111-111111111111',
  subject: 'admin',
  email: 'admin@example.com',
  role: UserRole.SUPER_ADMIN,
};

const userId = '22222222-2222-4222-8222-222222222222';
const keycloakSubject = 'keycloak-user-id';

function createHarness() {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: userId, keycloakSubject }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const keycloak = {
    resetUserPassword: vi.fn().mockResolvedValue({
      temporaryPassword: 'generated-password-value',
      generated: true,
    }),
  };
  const service = new AdminService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    keycloak as never,
    {} as never,
    {} as never,
  );
  return { keycloak, prisma, service };
}

describe('administrator password reset', () => {
  it('is protected by the SUPER_ADMIN controller role', () => {
    expect(Reflect.getMetadata(REQUIRED_ROLES, AdminController)).toEqual([UserRole.SUPER_ADMIN]);
  });

  it('marks the one-time credential response as non-cacheable', async () => {
    const resetUserPassword = vi.fn().mockResolvedValue({
      userId,
      temporaryPassword: 'one-time-password',
      generated: true,
    });
    const controller = new AdminController({ resetUserPassword } as never);
    const reply = { header: vi.fn() };

    await expect(
      controller.resetUserPassword(
        userId,
        {},
        actor,
        { id: 'request-id' } as never,
        reply as never,
      ),
    ).resolves.toMatchObject({ temporaryPassword: 'one-time-password' });
    expect(reply.header).toHaveBeenCalledWith('cache-control', 'no-store');
    expect(reply.header).toHaveBeenCalledWith('pragma', 'no-cache');
  });

  it('resets a Keycloak password and audits no credential material', async () => {
    const { keycloak, prisma, service } = createHarness();

    await expect(service.resetUserPassword(userId, {}, actor, 'request-id')).resolves.toEqual({
      userId,
      temporaryPassword: 'generated-password-value',
      generated: true,
    });
    expect(keycloak.resetUserPassword).toHaveBeenCalledWith(keycloakSubject, undefined);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: actor.userId,
        action: 'user.password.reset',
        entityType: 'User',
        entityId: userId,
        requestId: 'request-id',
        metadata: { temporary: true, generated: true },
      },
    });
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      'generated-password-value',
    );
  });

  it('accepts a supplied password but rejects one shorter than 12 characters', async () => {
    const { keycloak, service } = createHarness();
    keycloak.resetUserPassword.mockResolvedValue({
      temporaryPassword: 'user-chosen-password',
      generated: false,
    });

    await expect(
      service.resetUserPassword(
        userId,
        { temporaryPassword: 'user-chosen-password' },
        actor,
        'request-id',
      ),
    ).resolves.toMatchObject({ temporaryPassword: 'user-chosen-password', generated: false });
    expect(keycloak.resetUserPassword).toHaveBeenCalledWith(
      keycloakSubject,
      'user-chosen-password',
    );

    await expect(
      service.resetUserPassword(userId, { temporaryPassword: 'too-short' }, actor, 'request-id'),
    ).rejects.toMatchObject({ code: 'invalid_request_error', statusCode: 400 });
  });

  it('uses the Keycloak reset-password contract and generates a strong temporary value', async () => {
    const service = Object.create(KeycloakAdminService.prototype) as KeycloakAdminService;
    const internals = service as unknown as {
      adminToken: ReturnType<typeof vi.fn>;
      request: ReturnType<typeof vi.fn>;
      expect: ReturnType<typeof vi.fn>;
    };
    internals.adminToken = vi.fn().mockResolvedValue('admin-token');
    internals.request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    internals.expect = vi.fn().mockResolvedValue(undefined);

    const result = await service.resetUserPassword('subject/with/slash');

    expect(result.generated).toBe(true);
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(12);
    expect(internals.request).toHaveBeenCalledWith(
      '/users/subject%2Fwith%2Fslash/reset-password',
      'admin-token',
      'PUT',
      {
        type: 'password',
        value: result.temporaryPassword,
        temporary: true,
      },
    );
  });

  it('keeps a redacted Keycloak error body for internal diagnostics only', async () => {
    const service = Object.create(KeycloakAdminService.prototype) as KeycloakAdminService;
    const internals = service as unknown as {
      adminToken: ReturnType<typeof vi.fn>;
      request: ReturnType<typeof vi.fn>;
    };
    internals.adminToken = vi.fn().mockResolvedValue('admin-token');
    internals.request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          errorCode: 'PASSWORD_POLICY_REJECTED',
          constraint: 'length',
          temporaryPassword: 'must-never-reach-logs',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );

    let thrown: unknown;
    try {
      await service.resetUserPassword('subject-id', 'valid-temporary-password');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    const diagnostic = (thrown as AppError).causeForLog as Error;
    expect(diagnostic.message).toContain('PASSWORD_POLICY_REJECTED');
    expect(diagnostic.message).toContain('length');
    expect(diagnostic.message).not.toContain('must-never-reach-logs');
  });
});
