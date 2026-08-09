import { Prisma, type PublishedModel } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { GatewayService } from '../src/gateway/gateway.service';

type Price = Prisma.Decimal | null;

function createHarness(customInput: Price, customOutput: Price) {
  const model = {
    id: 'model-id',
    upstreamModelId: 'upstream-id',
    active: true,
    capabilities: { chat: true },
    promptMode: 'NONE',
    systemPrompt: null,
    thinkingLevel: 'PROVIDER_DEFAULT',
    maxRetries: 0,
    inputPricePerM: new Prisma.Decimal('2.50000000'),
    outputPricePerM: new Prisma.Decimal('5.00000000'),
  } as unknown as PublishedModel;
  const provider = {
    id: 'provider-id',
    name: 'private provider',
    active: true,
    type: 'GENERIC_OPENAI',
    timeoutMs: 30_000,
  };
  const grant = {
    active: true,
    alias: 'public-model',
    customInputPricePerM: customInput,
    customOutputPricePerM: customOutput,
    publishedModel: { ...model, provider },
  };
  const providerAttemptUpdate = vi.fn().mockResolvedValue({});
  const inferenceRequestUpdate = vi.fn().mockResolvedValue({});
  const prisma = {
    userModelGrant: { findUnique: vi.fn().mockResolvedValue(grant) },
    inferenceRequest: {
      create: vi.fn().mockResolvedValue({ id: 'inference-id' }),
      update: inferenceRequestUpdate,
    },
    providerAttempt: {
      create: vi.fn().mockResolvedValue({ id: 'attempt-id' }),
      update: providerAttemptUpdate,
    },
    $transaction: vi.fn(async (operations: unknown[]) => Promise.all(operations)),
  };
  const adapters = {
    execute: vi.fn().mockResolvedValue({
      response: new Response('{}'),
      wireFormat: 'openai-chat',
      requestedStream: false,
    }),
  };
  const normalizer = {
    buffered: vi.fn().mockResolvedValue({
      json: { id: 'safe-response' },
      usage: {
        inputTokens: 2_000_000,
        cachedInputTokens: 250_000,
        outputTokens: 1_000_000,
        reasoningTokens: 100_000,
        estimated: false,
      },
    }),
  };
  const gateway = new GatewayService(prisma as never, adapters as never, normalizer as never);
  return { gateway, prisma, providerAttemptUpdate, inferenceRequestUpdate };
}

async function execute(harness: ReturnType<typeof createHarness>) {
  await harness.gateway.execute(
    'chat',
    { model: 'public-model', messages: [{ role: 'user', content: 'hello' }] },
    {
      userId: 'user-id',
      apiKeyId: 'key-id',
      role: 'USER',
      subject: 'subject',
      email: 'user@example.com',
    },
    'request-id',
  );
}

describe('price inheritance and Decimal accounting', () => {
  it('inherits null user prices and stores exact global price snapshots', async () => {
    const harness = createHarness(null, null);

    await execute(harness);

    const created = harness.prisma.inferenceRequest.create.mock.calls[0]?.[0].data;
    expect(created.inputPriceSnapshot.toString()).toBe('2.5');
    expect(created.outputPriceSnapshot.toString()).toBe('5');
    const completed = harness.inferenceRequestUpdate.mock.calls[0]?.[0].data;
    expect(completed.costUsd.toString()).toBe('10');
    expect(completed.inputTokens).toBe(2_000_000);
    expect(completed.outputTokens).toBe(1_000_000);
    expect(completed.cachedInputTokens).toBe(250_000);
    expect(completed.reasoningTokens).toBe(100_000);
  });

  it('treats an explicit zero custom price as free instead of inheriting', async () => {
    const harness = createHarness(new Prisma.Decimal(0), new Prisma.Decimal('1.25'));

    await execute(harness);

    const created = harness.prisma.inferenceRequest.create.mock.calls[0]?.[0].data;
    expect(created.inputPriceSnapshot.toString()).toBe('0');
    expect(created.outputPriceSnapshot.toString()).toBe('1.25');
    const completed = harness.inferenceRequestUpdate.mock.calls[0]?.[0].data;
    expect(completed.costUsd.toString()).toBe('1.25');
  });

  it('uses Decimal arithmetic without floating-point drift', () => {
    const input = new Prisma.Decimal('0.1').mul(3);
    const output = new Prisma.Decimal('0.2').mul(7);
    const cost = input.add(output).div(1_000_000);

    expect(cost.toString()).toBe('0.0000017');
  });
});
