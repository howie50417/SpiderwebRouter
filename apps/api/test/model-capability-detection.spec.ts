import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection } from '@prisma/client';
import { detectModelCapabilities } from '../src/gateway/model-capability-detection';
import { ProviderAdapterService } from '../src/gateway/provider-adapter.service';

const capabilityKeys = [
  'chat',
  'responses',
  'embeddings',
  'vision',
  'tools',
  'structuredOutput',
  'streaming',
  'reasoning',
];

function provider(type: ProviderConnection['type'] = 'GENERIC_OPENAI'): ProviderConnection {
  return {
    id: 'provider-id',
    name: 'provider',
    type,
    baseUrl: 'https://models.example/v1',
    authMode: 'NONE',
    encryptedSecret: null,
    active: true,
    timeoutMs: 30_000,
    healthStatus: 'UNKNOWN',
    lastHealthCheckAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  };
}

function adapter(fetch: ReturnType<typeof vi.fn>): ProviderAdapterService {
  return new ProviderAdapterService(
    { fetch } as never,
    { decryptSecret: vi.fn().mockReturnValue(undefined) } as never,
  );
}

describe('passive model capability detection', () => {
  it('keeps every undeclared capability unconfirmed and never guesses from the model ID', () => {
    const detection = detectModelCapabilities(
      { id: 'unsloth/DeepSeek-V4-Flash-0731-GGUF', object: 'model' },
      { emulateResponsesFromChat: true },
    );

    expect(Object.keys(detection.capabilities)).toEqual([...capabilityKeys, 'nativeResponses']);
    expect(detection.capabilities).toEqual({
      chat: 'unconfirmed',
      responses: 'unconfirmed',
      embeddings: 'unconfirmed',
      vision: 'unconfirmed',
      tools: 'unconfirmed',
      structuredOutput: 'unconfirmed',
      streaming: 'unconfirmed',
      reasoning: 'unconfirmed',
      nativeResponses: false,
    });
    expect(detection.supportedThinkingLevels).toBeUndefined();
  });

  it('understands common nested object, list, endpoint, task and modality declarations', () => {
    const detection = detectModelCapabilities({
      capabilities: {
        supportsChat: true,
        function_calling: { supported: true },
        json_schema: 'enabled',
        embeddings: false,
      },
      supported_features: ['streaming', { name: 'thinking', available: true }],
      endpoints: ['/v1/responses'],
      inputModalities: ['text', 'image'],
      metadata: { tasks: ['sentence-similarity'] },
    });

    expect(detection.capabilities).toEqual({
      chat: true,
      responses: true,
      embeddings: 'unconfirmed',
      vision: true,
      tools: true,
      structuredOutput: true,
      streaming: true,
      reasoning: true,
      nativeResponses: true,
    });
    expect(detection.evidence.tools?.[0]?.path).toBe('capabilities.function_calling');
  });

  it('marks Responses as Router-emulated only when Chat is explicitly supported', () => {
    const emulated = detectModelCapabilities(
      { capabilities: ['chat', 'tools'] },
      { emulateResponsesFromChat: true },
    );
    expect(emulated.capabilities.responses).toBe(true);
    expect(emulated.capabilities.nativeResponses).toBe(false);
    expect(emulated.evidence.responses).toContainEqual(
      expect.objectContaining({ source: 'router_emulation', emulated: true, via: 'chat' }),
    );

    const native = detectModelCapabilities(
      { capabilities: ['chat', 'responses'] },
      { emulateResponsesFromChat: true },
    );
    expect(native.capabilities.responses).toBe(true);
    expect(native.capabilities.nativeResponses).toBe(true);
    expect(native.evidence.responses).not.toContainEqual(
      expect.objectContaining({ source: 'router_emulation' }),
    );
  });

  it('preserves explicit false and resolves contradictory declarations as unconfirmed', () => {
    const detection = detectModelCapabilities({
      capabilities: { vision: false, tools: true },
      metadata: { capabilities: { tools: false } },
    });
    expect(detection.capabilities.vision).toBe(false);
    expect(detection.capabilities.tools).toBe('unconfirmed');
  });

  it('retains only explicitly advertised thinking levels, including extended tiers', () => {
    const detection = detectModelCapabilities({
      capabilities: {
        reasoning: {
          supported: true,
          levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'turbo'],
        },
      },
    });
    expect(detection.capabilities.reasoning).toBe(true);
    expect(detection.supportedThinkingLevels).toEqual([
      'OFF',
      'MINIMAL',
      'LOW',
      'MEDIUM',
      'HIGH',
      'XHIGH',
      'MAX',
    ]);
  });

  it('maps Gemini generation methods and thinking metadata without inventing effort tiers', () => {
    const detection = detectModelCapabilities(
      {
        supportedGenerationMethods: [
          'generateContent',
          'streamGenerateContent',
          'batchEmbedContents',
        ],
        thinking: true,
      },
      { emulateResponsesFromChat: true },
    );
    expect(detection.capabilities).toMatchObject({
      chat: true,
      responses: true,
      embeddings: true,
      streaming: true,
      reasoning: true,
      nativeResponses: false,
    });
    expect(detection.supportedThinkingLevels).toBeUndefined();
  });
});

describe('provider scan capability enrichment', () => {
  it('enriches only the exact active Unsloth model from one read-only status request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'unsloth/active-model',
                object: 'model',
                owned_by: 'unsloth-studio',
                loaded: true,
              },
              {
                id: 'unsloth/inactive-model',
                object: 'model',
                owned_by: 'unsloth-studio',
                loaded: false,
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            active_model: 'unsloth/active-model',
            model_identifier: '/models/private-active-path',
            is_vision: true,
            supports_tools: true,
            supports_reasoning: true,
            reasoning_style: 'enable_thinking_effort',
            reasoning_effort_levels: ['high', 'max'],
            reasoning_always_on: false,
          }),
        ),
      );

    const models = await adapter(fetch).scan(provider());

    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1]![0] as URL).toString()).toBe('https://models.example/v1/status');
    expect(models[0]?.capabilities).toMatchObject({
      chat: true,
      responses: true,
      streaming: true,
      vision: true,
      tools: true,
      reasoning: true,
      embeddings: 'unconfirmed',
      structuredOutput: 'unconfirmed',
      nativeResponses: true,
    });
    expect(models[0]?.metadata?.supportedThinkingLevels).toEqual(['OFF', 'HIGH', 'MAX']);
    expect(models[1]?.capabilities).toMatchObject({
      vision: 'unconfirmed',
      tools: 'unconfirmed',
      reasoning: 'unconfirmed',
    });
    expect(models[1]?.metadata?.supportedThinkingLevels).toBeUndefined();
  });

  it('does not offer OFF for an always-on reasoning model', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'active-model',
                owned_by: 'unsloth-studio',
                loaded: true,
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            active_model: 'active-model',
            supports_reasoning: true,
            reasoning_effort_levels: ['minimal', 'xhigh'],
            reasoning_always_on: true,
          }),
        ),
      );

    const [model] = await adapter(fetch).scan(provider());
    expect(model?.metadata?.supportedThinkingLevels).toEqual(['MINIMAL', 'XHIGH']);
  });

  it('keeps a successful catalog scan when optional Unsloth status is unavailable', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 'model', owned_by: 'unsloth-studio', loaded: true }],
          }),
        ),
      )
      .mockRejectedValueOnce(new Error('404'));

    const models = await adapter(fetch).scan(provider());
    expect(models).toHaveLength(1);
    expect(models[0]?.capabilities.reasoning).toBe('unconfirmed');
  });

  it('does not probe status for an ordinary OpenAI-compatible catalog', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'ordinary-model' }] })));
    await adapter(fetch).scan(provider());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses nativeResponses rather than the public Responses flag to choose Generic wire API', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] })));
    const service = adapter(fetch);
    const publishedModel = {
      upstreamModelId: 'private-model',
      capabilities: { chat: true, responses: true, nativeResponses: false },
    } as never;

    await service.execute(
      provider(),
      publishedModel,
      'responses',
      { model: 'public-model', input: 'hello' },
      false,
    );
    expect((fetch.mock.calls[0]![0] as URL).pathname).toBe('/v1/chat/completions');

    fetch.mockClear();
    await service.execute(
      provider(),
      {
        upstreamModelId: 'private-model',
        capabilities: { chat: true, responses: true, nativeResponses: true },
      } as never,
      'responses',
      { model: 'public-model', input: 'hello' },
      false,
    );
    expect((fetch.mock.calls[0]![0] as URL).pathname).toBe('/v1/responses');
  });
});
