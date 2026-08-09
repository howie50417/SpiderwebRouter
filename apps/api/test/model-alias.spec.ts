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
  const publishedModelCreate = vi.fn().mockResolvedValue({ id: 'published-model-id' });
  const grantUpsert = vi.fn().mockResolvedValue({ id: 'grant-id' });
  const prisma = {
    providerConnection: {
      findFirst: vi.fn().mockResolvedValue({
        id: '22222222-2222-4222-8222-222222222222',
        deletedAt: null,
      }),
    },
    publishedModel: {
      create: publishedModelCreate,
      findFirst: vi.fn().mockResolvedValue({
        id: '44444444-4444-4444-8444-444444444444',
        deletedAt: null,
      }),
    },
    userModelGrant: { upsert: grantUpsert },
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

  return { service, prisma, publishedModelCreate, grantUpsert };
}

describe('model alias validation', () => {
  it('accepts a slash in a global public model alias', async () => {
    const { service, prisma, publishedModelCreate } = createHarness();
    const alias = 'unsloth/DeepSeek-V4-Flash-0731-GGUF';

    await service.createModel(
      {
        providerId: '22222222-2222-4222-8222-222222222222',
        upstreamModelId: alias,
        defaultAlias: alias,
      },
      actor,
      'request-id',
    );

    expect(publishedModelCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ defaultAlias: alias }),
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('accepts a slash in a user-specific model alias', async () => {
    const { service, grantUpsert } = createHarness();
    const alias = 'team/private-model';

    await service.upsertGrant(
      {
        userId: '33333333-3333-4333-8333-333333333333',
        publishedModelId: '44444444-4444-4444-8444-444444444444',
        alias,
      },
      actor,
      'request-id',
    );

    expect(grantUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ alias }),
      }),
    );
  });
});
