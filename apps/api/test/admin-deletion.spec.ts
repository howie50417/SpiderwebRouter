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

function createHarness() {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333' }),
    },
    providerConnection: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    publishedModel: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    userModelGrant: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({ id: 'grant-id' }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
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

describe('admin resource deletion', () => {
  it('physically deletes a provider and its models when no history blocks it', async () => {
    const { prisma, service } = createHarness();

    await expect(service.deleteProvider('provider-id', actor, 'request-id')).resolves.toEqual({
      id: 'provider-id',
      deleted: true,
      hidden: true,
      mode: 'HARD_DELETE',
      reason: null,
    });

    expect(prisma.publishedModel.deleteMany).toHaveBeenCalledWith({
      where: { providerId: 'provider-id' },
    });
    expect(prisma.providerConnection.deleteMany).toHaveBeenCalledWith({
      where: { id: 'provider-id', deletedAt: null },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'provider.delete', entityId: 'provider-id' }),
    });
  });

  it('archives a provider, releases names and grants, and preserves history on P2003', async () => {
    const { prisma, service } = createHarness();
    prisma.publishedModel.deleteMany.mockRejectedValueOnce({ code: 'P2003' });
    prisma.providerConnection.findFirst.mockResolvedValue({ name: 'Upstream' });
    prisma.publishedModel.findMany.mockResolvedValue([
      { id: 'model-one', defaultAlias: 'first/model' },
      { id: 'model-two', defaultAlias: 'second/model' },
    ]);

    await expect(service.deleteProvider('provider-id', actor, 'request-id')).resolves.toEqual({
      id: 'provider-id',
      deleted: true,
      hidden: true,
      mode: 'ARCHIVED',
      reason: 'HISTORY_PRESERVED',
    });

    expect(prisma.userModelGrant.deleteMany).toHaveBeenCalledWith({
      where: { publishedModel: { providerId: 'provider-id' } },
    });
    expect(prisma.providerConnection.update).toHaveBeenCalledWith({
      where: { id: 'provider-id' },
      data: expect.objectContaining({
        active: false,
        encryptedSecret: null,
        name: 'Upstream [deleted:provider-id]',
        deletedAt: expect.any(Date),
      }),
    });
    expect(prisma.publishedModel.update).toHaveBeenCalledTimes(2);
    expect(prisma.publishedModel.update).toHaveBeenCalledWith({
      where: { id: 'model-one' },
      data: expect.objectContaining({
        active: false,
        defaultAlias: 'first/model [deleted:model-one]',
        deletedAt: expect.any(Date),
      }),
    });
  });

  it('physically deletes an unused model', async () => {
    const { service } = createHarness();

    await expect(service.deleteModel('model-id', actor, 'request-id')).resolves.toEqual({
      id: 'model-id',
      deleted: true,
      hidden: true,
      mode: 'HARD_DELETE',
      reason: null,
    });
  });

  it('retries a serializable deletion transaction after a write conflict', async () => {
    const { prisma, service } = createHarness();
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });

    await expect(service.deleteModel('model-id', actor, 'request-id')).resolves.toMatchObject({
      mode: 'HARD_DELETE',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('archives a used model and releases its public and user aliases', async () => {
    const { prisma, service } = createHarness();
    prisma.publishedModel.deleteMany.mockRejectedValueOnce({ code: 'P2003' });
    prisma.publishedModel.findFirst.mockResolvedValue({ defaultAlias: 'public/model' });

    await expect(service.deleteModel('model-id', actor, 'request-id')).resolves.toEqual({
      id: 'model-id',
      deleted: true,
      hidden: true,
      mode: 'ARCHIVED',
      reason: 'HISTORY_PRESERVED',
    });

    expect(prisma.userModelGrant.deleteMany).toHaveBeenCalledWith({
      where: { publishedModelId: 'model-id' },
    });
    expect(prisma.publishedModel.update).toHaveBeenCalledWith({
      where: { id: 'model-id' },
      data: expect.objectContaining({
        active: false,
        defaultAlias: 'public/model [deleted:model-id]',
        deletedAt: expect.any(Date),
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'model.archive',
        metadata: {
          reason: 'HISTORY_PRESERVED',
          originalAlias: 'public/model',
        },
      }),
    });
  });

  it('hides archived providers and models from management lists', async () => {
    const { prisma, service } = createHarness();
    await service.listProviders();
    await service.listModels();
    await service.listGrants();

    expect(prisma.providerConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null },
        select: expect.objectContaining({
          _count: {
            select: {
              discoveredModels: true,
              publishedModels: { where: { deletedAt: null } },
            },
          },
        }),
      }),
    );
    expect(prisma.publishedModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, provider: { deletedAt: null } },
      }),
    );
    expect(prisma.userModelGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          publishedModel: { deletedAt: null, provider: { deletedAt: null } },
        },
      }),
    );
  });

  it('does not allow a grant to recreate access to an archived model', async () => {
    const { prisma, service } = createHarness();
    prisma.publishedModel.findFirst.mockResolvedValue(null);

    await expect(
      service.upsertGrant(
        {
          userId: '33333333-3333-4333-8333-333333333333',
          publishedModelId: '44444444-4444-4444-8444-444444444444',
          alias: 'hidden/model',
        },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.userModelGrant.upsert).not.toHaveBeenCalled();
  });
});
