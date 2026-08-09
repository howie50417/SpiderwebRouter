import { describe, expect, it, vi } from 'vitest';
import { MeService } from '../src/me/me.service';

describe('customer model policy projection', () => {
  it('exposes thinking and parameter policy without upstream or provider identity', async () => {
    const prisma = {
      userModelGrant: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'grant-id',
            alias: 'customer-alias',
            customInputPricePerM: null,
            customOutputPricePerM: null,
            publishedModel: {
              displayName: 'Customer model',
              capabilities: { chat: true, responses: true, reasoning: true },
              upstreamModelId: 'gpt-5.6-sol',
              thinkingControlMode: 'USER_SELECTABLE',
              supportedThinkingLevels: ['OFF', 'LOW', 'HIGH'],
              inputPricePerM: '1',
              outputPricePerM: '2',
              provider: { type: 'OPENAI' },
            },
          },
        ]),
      },
    };
    const service = new MeService(prisma as never, {} as never, {} as never);

    const models = await service.models({ userId: 'user-id' } as never);
    expect(models).toEqual([
      expect.objectContaining({
        alias: 'customer-alias',
        thinkingControlMode: 'USER_SELECTABLE',
        supportedThinkingLevels: ['OFF', 'LOW', 'HIGH'],
        parameterSupport: { temperature: false },
      }),
    ]);
    expect(models[0]).not.toHaveProperty('upstreamModelId');
    expect(models[0]).not.toHaveProperty('provider');
    expect(models[0]).not.toHaveProperty('providerId');
  });
});
