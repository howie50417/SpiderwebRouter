import { UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedPrincipal } from '../src/auth/auth.types';

const actor: AuthenticatedPrincipal = {
  userId: '11111111-1111-4111-8111-111111111111',
  subject: 'admin',
  email: 'admin@example.com',
  role: UserRole.SUPER_ADMIN,
};

const userId = '22222222-2222-4222-8222-222222222222';
const firstModelId = '33333333-3333-4333-8333-333333333333';
const secondModelId = '44444444-4444-4444-8444-444444444444';

function createHarness() {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: userId }),
    },
    publishedModel: {
      findMany: vi.fn().mockResolvedValue([
        { id: firstModelId, upstreamModelId: 'upstream/first' },
        { id: secondModelId, upstreamModelId: 'upstream/second' },
      ]),
    },
    userModelGrant: {
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (work: (tx: typeof prisma) => Promise<unknown>) =>
    work(prisma),
  );
  const service = new AdminService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { prisma, service };
}

describe('batch model grants', () => {
  it('atomically creates new grants, skips existing models, and uses upstream IDs as aliases', async () => {
    const { prisma, service } = createHarness();
    const existingGrant = {
      id: 'existing-grant',
      userId,
      publishedModelId: firstModelId,
      alias: 'custom-existing-alias',
    };
    const createdGrant = {
      id: 'created-grant',
      userId,
      publishedModelId: secondModelId,
      alias: 'upstream/second',
    };
    prisma.userModelGrant.findMany
      .mockResolvedValueOnce([{ publishedModelId: firstModelId }])
      .mockResolvedValueOnce([existingGrant, createdGrant]);

    await expect(
      service.createGrantsBatch(
        userId,
        { publishedModelIds: [firstModelId, secondModelId] },
        actor,
        'request-id',
      ),
    ).resolves.toEqual({
      userId,
      created: 1,
      skippedExisting: 1,
      grants: [existingGrant, createdGrant],
    });

    expect(prisma.publishedModel.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [firstModelId, secondModelId] },
        deletedAt: null,
        provider: { deletedAt: null },
      },
      select: { id: true, upstreamModelId: true },
    });
    expect(prisma.userModelGrant.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId,
          publishedModelId: secondModelId,
          alias: 'upstream/second',
          active: true,
          customInputPricePerM: null,
          customOutputPricePerM: null,
        },
      ],
    });
    expect(prisma.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          action: 'grant.batch.create',
          entityId: 'created-grant',
          metadata: { userId, publishedModelId: secondModelId },
        }),
      ],
    });
  });

  it('is idempotent and never overwrites existing grant settings', async () => {
    const { prisma, service } = createHarness();
    const existingGrants = [
      { id: 'first-grant', userId, publishedModelId: firstModelId, alias: 'private/first' },
      { id: 'second-grant', userId, publishedModelId: secondModelId, alias: 'private/second' },
    ];
    prisma.userModelGrant.findMany
      .mockResolvedValueOnce([
        { publishedModelId: firstModelId },
        { publishedModelId: secondModelId },
      ])
      .mockResolvedValueOnce(existingGrants);

    await expect(
      service.createGrantsBatch(
        userId,
        { publishedModelIds: [firstModelId, secondModelId] },
        actor,
        'request-id',
      ),
    ).resolves.toMatchObject({ created: 0, skippedExisting: 2, grants: existingGrants });
    expect(prisma.userModelGrant.createMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.createMany).not.toHaveBeenCalled();
  });

  it('rejects duplicate upstream aliases before writing any grant', async () => {
    const { prisma, service } = createHarness();
    prisma.publishedModel.findMany.mockResolvedValue([
      { id: firstModelId, upstreamModelId: 'same/upstream-name' },
      { id: secondModelId, upstreamModelId: 'same/upstream-name' },
    ]);
    prisma.userModelGrant.findMany.mockResolvedValueOnce([]);

    await expect(
      service.createGrantsBatch(
        userId,
        { publishedModelIds: [firstModelId, secondModelId] },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request_error',
      statusCode: 409,
      param: 'publishedModelIds',
      message: 'One or more model aliases are already in use for this user.',
    });
    expect(prisma.userModelGrant.createMany).not.toHaveBeenCalled();
  });

  it('rejects an alias already used by another grant before writing', async () => {
    const { prisma, service } = createHarness();
    prisma.userModelGrant.findMany.mockResolvedValueOnce([]);
    prisma.userModelGrant.findFirst.mockResolvedValue({ id: 'conflicting-grant' });

    await expect(
      service.createGrantsBatch(
        userId,
        { publishedModelIds: [firstModelId, secondModelId] },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({ statusCode: 409, param: 'publishedModelIds' });
    expect(prisma.userModelGrant.createMany).not.toHaveBeenCalled();
  });

  it('rejects deleted or missing models as a whole batch', async () => {
    const { prisma, service } = createHarness();
    prisma.publishedModel.findMany.mockResolvedValue([
      { id: firstModelId, upstreamModelId: 'upstream/first' },
    ]);

    await expect(
      service.createGrantsBatch(
        userId,
        { publishedModelIds: [firstModelId, secondModelId] },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({ statusCode: 404, param: 'publishedModelIds' });
    expect(prisma.userModelGrant.createMany).not.toHaveBeenCalled();
  });

  it('rejects a missing user before reading or writing model grants', async () => {
    const { prisma, service } = createHarness();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.createGrantsBatch(userId, { publishedModelIds: [firstModelId] }, actor, 'request-id'),
    ).rejects.toMatchObject({ statusCode: 404, param: 'userId' });
    expect(prisma.publishedModel.findMany).not.toHaveBeenCalled();
    expect(prisma.userModelGrant.createMany).not.toHaveBeenCalled();
  });

  it('rejects an upstream model ID that is not a valid public alias', async () => {
    const { prisma, service } = createHarness();
    prisma.publishedModel.findMany.mockResolvedValue([
      { id: firstModelId, upstreamModelId: 'model name with spaces' },
    ]);
    prisma.userModelGrant.findMany.mockResolvedValueOnce([]);

    await expect(
      service.createGrantsBatch(userId, { publishedModelIds: [firstModelId] }, actor, 'request-id'),
    ).rejects.toMatchObject({
      statusCode: 400,
      param: 'publishedModelIds',
      message:
        'An upstream model ID cannot be used as an alias. Grant that model separately with a valid user-specific name.',
    });
    expect(prisma.userModelGrant.createMany).not.toHaveBeenCalled();
  });
});
