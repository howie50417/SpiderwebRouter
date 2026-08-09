import { Prisma, type PublishedModel } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { appLogger } from '../src/common/logger';
import { GatewayService } from '../src/gateway/gateway.service';
import { ProviderError } from '../src/gateway/provider-error';

beforeAll(() => {
  vi.spyOn(appLogger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(appLogger, 'error').mockImplementation(() => undefined);
});

function createHarness(maxRetries: number, adapterResults: Array<ProviderError | 'success'>) {
  const model = {
    id: 'model-id',
    upstreamModelId: 'upstream-id',
    active: true,
    capabilities: { chat: true },
    promptMode: 'NONE',
    systemPrompt: null,
    thinkingLevel: 'PROVIDER_DEFAULT',
    maxRetries,
    inputPricePerM: new Prisma.Decimal('1'),
    outputPricePerM: new Prisma.Decimal('2'),
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
    customInputPricePerM: null,
    customOutputPricePerM: null,
    publishedModel: { ...model, provider },
  };
  const inferenceRequestUpdate = vi.fn().mockResolvedValue({});
  const providerAttemptCreate = vi
    .fn()
    .mockImplementation(async ({ data }: { data: { attemptNumber: number } }) => ({
      id: `attempt-${data.attemptNumber}`,
    }));
  const providerAttemptUpdate = vi.fn().mockResolvedValue({});
  const prisma = {
    userModelGrant: { findUnique: vi.fn().mockResolvedValue(grant) },
    inferenceRequest: {
      create: vi.fn().mockResolvedValue({ id: 'inference-id' }),
      update: inferenceRequestUpdate,
    },
    providerAttempt: { create: providerAttemptCreate, update: providerAttemptUpdate },
    $transaction: vi.fn(async (operations: unknown[]) => Promise.all(operations)),
  };
  let resultIndex = 0;
  const adapters = {
    execute: vi.fn().mockImplementation(async () => {
      const next = adapterResults[resultIndex++];
      if (next instanceof ProviderError) throw next;
      return { response: new Response('{}'), wireFormat: 'openai-chat', requestedStream: false };
    }),
  };
  const normalizer = {
    buffered: vi.fn().mockResolvedValue({
      json: { id: 'safe-response' },
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
        estimated: false,
      },
    }),
  };
  return {
    gateway: new GatewayService(prisma as never, adapters as never, normalizer as never),
    adapters,
    inferenceRequestUpdate,
    providerAttemptCreate,
    providerAttemptUpdate,
    prisma,
  };
}

async function execute(harness: ReturnType<typeof createHarness>) {
  return harness.gateway.execute(
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

describe('gateway retry attempt accounting', () => {
  it('does not retry an upstream 4xx and records zero retries', async () => {
    const harness = createHarness(5, [
      new ProviderError('bad upstream request', {
        category: 'http',
        status: 400,
        rawBody: '{"error":"private upstream diagnostic"}',
      }),
    ]);

    await expect(execute(harness)).rejects.toMatchObject({
      code: 'provider_unavailable',
      statusCode: 503,
    });

    expect(harness.adapters.execute).toHaveBeenCalledTimes(1);
    expect(harness.providerAttemptCreate).toHaveBeenCalledTimes(1);
    expect(harness.inferenceRequestUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          retryCount: 0,
          safeErrorCode: 'provider_unavailable',
        }),
      }),
    );
    expect(harness.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('retries eligible errors and bills only the eventual successful attempt', async () => {
    const harness = createHarness(2, [
      new ProviderError('busy', { category: 'http', status: 429, retryAfterMs: 0 }),
      new ProviderError('temporary', { category: 'http', status: 503, retryAfterMs: 0 }),
      'success',
    ]);

    await expect(execute(harness)).resolves.toMatchObject({
      stream: false,
      json: { id: 'safe-response' },
    });

    expect(harness.adapters.execute).toHaveBeenCalledTimes(3);
    expect(harness.providerAttemptCreate).toHaveBeenCalledTimes(3);
    expect(harness.providerAttemptUpdate).toHaveBeenCalledTimes(3);
    const completion = harness.inferenceRequestUpdate.mock.calls.at(-1)?.[0].data;
    expect(completion.status).toBe('SUCCEEDED');
    expect(completion.retryCount).toBe(2);
    expect(completion.inputTokens).toBe(10);
    expect(completion.outputTokens).toBe(5);
    expect(completion.costUsd.toString()).toBe('0.00002');
  });

  it('honors maxRetries as retries in addition to the initial attempt', async () => {
    const harness = createHarness(2, [
      new ProviderError('temporary', { category: 'connection', retryAfterMs: 0 }),
      new ProviderError('temporary', { category: 'timeout', retryAfterMs: 0 }),
      new ProviderError('temporary', { category: 'http', status: 503, retryAfterMs: 0 }),
    ]);

    await expect(execute(harness)).rejects.toMatchObject({ code: 'provider_unavailable' });

    expect(harness.adapters.execute).toHaveBeenCalledTimes(3);
    expect(harness.providerAttemptCreate).toHaveBeenCalledTimes(3);
    expect(harness.inferenceRequestUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', retryCount: 2 }),
      }),
    );
  });

  it('cancels before the first provider attempt without counting a retry', async () => {
    const harness = createHarness(5, ['success']);
    const abort = new AbortController();
    abort.abort(new Error('client disconnected'));

    await expect(
      harness.gateway.execute(
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
        abort.signal,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });

    expect(harness.adapters.execute).not.toHaveBeenCalled();
    expect(harness.providerAttemptCreate).not.toHaveBeenCalled();
    expect(harness.inferenceRequestUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED', retryCount: 0 }),
      }),
    );
  });
});
