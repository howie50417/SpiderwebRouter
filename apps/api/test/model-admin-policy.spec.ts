import { ThinkingControlMode, UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedPrincipal } from '../src/auth/auth.types';

const actor: AuthenticatedPrincipal = {
  userId: '11111111-1111-4111-8111-111111111111',
  subject: 'admin',
  email: 'admin@example.com',
  role: UserRole.SUPER_ADMIN,
};
const providerId = '22222222-2222-4222-8222-222222222222';

function harness() {
  const prisma = {
    providerConnection: {
      findFirst: vi.fn().mockResolvedValue({ id: providerId, active: true, deletedAt: null }),
    },
    discoveredModel: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    publishedModel: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ id: 'model-id', ...data })),
      update: vi
        .fn()
        .mockImplementation(({ data }) => Promise.resolve({ id: 'model-id', ...data })),
    },
    scanJob: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (work: (tx: typeof prisma) => Promise<unknown>) =>
    work(prisma),
  );
  return {
    prisma,
    service: new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ),
  };
}

describe('published model policy snapshots', () => {
  it('snapshots every confirmed candidate capability and all reported thinking levels', async () => {
    const { prisma, service } = harness();
    prisma.discoveredModel.findUnique.mockResolvedValue({
      available: true,
      capabilities: {
        chat: true,
        responses: true,
        embeddings: 'unconfirmed',
        vision: true,
        tools: true,
        structuredOutput: true,
        streaming: true,
        reasoning: true,
        nativeResponses: true,
      },
      metadata: { supportedThinkingLevels: ['OFF', 'HIGH', 'MAX'] },
    });

    await service.createModel(
      {
        providerId,
        upstreamModelId: 'gpt-5.6-sol',
        defaultAlias: 'public-model',
        capabilities: { embeddings: true },
        thinkingControlMode: 'USER_SELECTABLE',
        supportedThinkingLevels: ['HIGH'],
      },
      actor,
      'request-id',
    );

    expect(prisma.publishedModel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        thinkingControlMode: ThinkingControlMode.USER_SELECTABLE,
        supportedThinkingLevels: ['OFF', 'HIGH', 'MAX'],
        capabilities: expect.objectContaining({
          chat: true,
          responses: true,
          embeddings: false,
          vision: true,
          nativeResponses: true,
        }),
      }),
    });
  });

  it('does not permit USER_SELECTABLE without a confirmed source tier', async () => {
    const { prisma, service } = harness();
    prisma.discoveredModel.findUnique.mockResolvedValue({
      available: true,
      capabilities: { chat: true },
      metadata: {},
    });

    await expect(
      service.createModel(
        {
          providerId,
          upstreamModelId: 'unknown-model',
          defaultAlias: 'unknown-model',
          thinkingControlMode: 'USER_SELECTABLE',
        },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request_error',
      statusCode: 400,
      param: 'thinkingControlMode',
    });
    expect(prisma.publishedModel.create).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied tiers when there is no current available discovery', async () => {
    const { prisma, service } = harness();

    await expect(
      service.createModel(
        {
          providerId,
          upstreamModelId: 'unscanned-model',
          defaultAlias: 'unscanned-model',
          supportedThinkingLevels: ['MAX'],
        },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({
      code: 'invalid_request_error',
      statusCode: 400,
      param: 'supportedThinkingLevels',
    });
    expect(prisma.publishedModel.create).not.toHaveBeenCalled();
  });

  it('rejects a tier that is absent from the matching available discovery', async () => {
    const { prisma, service } = harness();
    prisma.discoveredModel.findUnique.mockResolvedValue({
      available: true,
      capabilities: { chat: true, reasoning: true },
      metadata: { supportedThinkingLevels: ['LOW', 'HIGH'] },
    });

    await expect(
      service.createModel(
        {
          providerId,
          upstreamModelId: 'confirmed-model',
          defaultAlias: 'confirmed-model',
          thinkingControlMode: 'USER_SELECTABLE',
          supportedThinkingLevels: ['MAX'],
        },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({ statusCode: 400, param: 'supportedThinkingLevels' });
    expect(prisma.publishedModel.create).not.toHaveBeenCalled();
  });

  it('preserves an existing snapshot but requires a current discovery before adding tiers', async () => {
    const preserved = harness();
    preserved.prisma.publishedModel.findFirst.mockResolvedValue({
      id: 'model-id',
      providerId,
      upstreamModelId: 'existing-model',
      promptMode: 'NONE',
      systemPrompt: null,
      thinkingLevel: 'PROVIDER_DEFAULT',
      thinkingControlMode: ThinkingControlMode.FIXED,
      supportedThinkingLevels: ['HIGH'],
    });
    await preserved.service.updateModel(
      'model-id',
      { displayName: 'Renamed' },
      actor,
      'request-id',
    );
    expect(preserved.prisma.discoveredModel.findUnique).not.toHaveBeenCalled();
    expect(preserved.prisma.publishedModel.update).toHaveBeenCalledWith({
      where: { id: 'model-id', deletedAt: null },
      data: expect.objectContaining({ supportedThinkingLevels: ['HIGH'] }),
    });

    const expanded = harness();
    expanded.prisma.publishedModel.findFirst.mockResolvedValue({
      id: 'model-id',
      providerId,
      upstreamModelId: 'existing-model',
      promptMode: 'NONE',
      systemPrompt: null,
      thinkingLevel: 'PROVIDER_DEFAULT',
      thinkingControlMode: ThinkingControlMode.FIXED,
      supportedThinkingLevels: ['HIGH'],
    });
    await expect(
      expanded.service.updateModel(
        'model-id',
        { supportedThinkingLevels: ['HIGH', 'MAX'] },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({ statusCode: 400, param: 'supportedThinkingLevels' });
    expect(expanded.prisma.publishedModel.update).not.toHaveBeenCalled();
  });

  it('refreshes a changed tier snapshot only from the matching available discovery', async () => {
    const { prisma, service } = harness();
    prisma.publishedModel.findFirst.mockResolvedValue({
      id: 'model-id',
      providerId,
      upstreamModelId: 'existing-model',
      promptMode: 'NONE',
      systemPrompt: null,
      thinkingLevel: 'PROVIDER_DEFAULT',
      thinkingControlMode: ThinkingControlMode.FIXED,
      supportedThinkingLevels: ['HIGH'],
    });
    prisma.discoveredModel.findUnique.mockResolvedValue({
      available: true,
      capabilities: { chat: true, reasoning: true },
      metadata: { supportedThinkingLevels: ['LOW', 'HIGH'] },
    });

    await service.updateModel(
      'model-id',
      { supportedThinkingLevels: ['LOW'] },
      actor,
      'request-id',
    );

    expect(prisma.discoveredModel.findUnique).toHaveBeenCalledWith({
      where: {
        providerId_upstreamModelId: { providerId, upstreamModelId: 'existing-model' },
      },
    });
    expect(prisma.publishedModel.update).toHaveBeenCalledWith({
      where: { id: 'model-id', deletedAt: null },
      data: expect.objectContaining({ supportedThinkingLevels: ['LOW', 'HIGH'] }),
    });
  });

  it('rejects stale candidates and duplicate provider/model bindings', async () => {
    const stale = harness();
    stale.prisma.discoveredModel.findUnique.mockResolvedValue({
      available: false,
      capabilities: {},
      metadata: {},
    });
    await expect(
      stale.service.createModel(
        { providerId, upstreamModelId: 'stale', defaultAlias: 'stale' },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({ statusCode: 409, param: 'upstreamModelId' });

    const duplicate = harness();
    duplicate.prisma.publishedModel.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(
      duplicate.service.createModel(
        { providerId, upstreamModelId: 'duplicate', defaultAlias: 'duplicate' },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({ statusCode: 409, param: 'upstreamModelId' });
  });

  it('accepts Provider default but rejects an unconfirmed fixed thinking level', async () => {
    const accepted = harness();
    accepted.prisma.discoveredModel.findUnique.mockResolvedValue({
      available: true,
      capabilities: { chat: true, reasoning: true },
      metadata: { supportedThinkingLevels: ['LOW', 'HIGH'] },
    });
    await expect(
      accepted.service.createModel(
        {
          providerId,
          upstreamModelId: 'confirmed-default',
          defaultAlias: 'confirmed-default',
          thinkingLevel: 'PROVIDER_DEFAULT',
        },
        actor,
        'request-id',
      ),
    ).resolves.toMatchObject({ thinkingLevel: 'PROVIDER_DEFAULT' });

    const rejected = harness();
    rejected.prisma.discoveredModel.findUnique.mockResolvedValue({
      available: true,
      capabilities: { chat: true, reasoning: true },
      metadata: { supportedThinkingLevels: ['LOW', 'HIGH'] },
    });
    await expect(
      rejected.service.createModel(
        {
          providerId,
          upstreamModelId: 'confirmed-fixed',
          defaultAlias: 'confirmed-fixed',
          thinkingLevel: 'MAX',
        },
        actor,
        'request-id',
      ),
    ).rejects.toMatchObject({ statusCode: 400, param: 'thinkingLevel' });
    expect(rejected.prisma.publishedModel.create).not.toHaveBeenCalled();
  });
});

describe('provider-scoped scan queries', () => {
  it('defaults candidates to currently available models and marks published rows', async () => {
    const { prisma, service } = harness();
    prisma.discoveredModel.findMany.mockResolvedValue([
      {
        id: 'candidate',
        providerId,
        upstreamModelId: 'model-one',
        provider: { id: providerId, name: 'OpenAI', type: 'OPENAI' },
      },
    ]);
    prisma.publishedModel.findMany.mockResolvedValue([
      { providerId, upstreamModelId: 'model-one' },
    ]);

    await expect(service.listDiscovered(providerId)).resolves.toEqual([
      expect.objectContaining({ id: 'candidate', published: true }),
    ]);
    expect(prisma.discoveredModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { providerId, available: true, provider: { deletedAt: null } },
      }),
    );
  });

  it('returns only the safe scan job status fields', async () => {
    const { prisma, service } = harness();
    const job = {
      id: 'job-id',
      providerId,
      status: 'SUCCEEDED',
      discoveredCount: 3,
      safeErrorCode: null,
      startedAt: new Date(1),
      finishedAt: new Date(2),
      createdAt: new Date(0),
    };
    prisma.scanJob.findFirst.mockResolvedValue(job);
    await expect(service.getModelScan('job-id')).resolves.toEqual(job);
    expect(prisma.scanJob.findFirst).toHaveBeenCalledWith({
      where: { id: 'job-id', provider: { deletedAt: null } },
      select: {
        id: true,
        providerId: true,
        status: true,
        discoveredCount: true,
        safeErrorCode: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
      },
    });
  });
});
