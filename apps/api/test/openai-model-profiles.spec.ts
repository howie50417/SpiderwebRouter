import { describe, expect, it } from 'vitest';
import { detectModelCapabilities } from '../src/gateway/model-capability-detection';
import {
  enrichWithOpenAIOfficialProfile,
  findOpenAIModelProfile,
  OPENAI_MODEL_PROFILES,
  resolveOpenAIModelProfile,
} from '../src/gateway/openai-model-profiles';
import { normalizePublishedCapabilities } from '../src/admin/admin.service';

describe('OpenAI official model profile registry', () => {
  it('uses only anchored model aliases and snapshots', () => {
    expect(findOpenAIModelProfile('gpt-5.6')).toMatchObject({ id: 'gpt-5.6' });
    expect(findOpenAIModelProfile('gpt-5.6-sol-2026-08-01')).toMatchObject({ id: 'gpt-5.6' });
    expect(findOpenAIModelProfile('gpt-5.6-terra')).toMatchObject({ id: 'gpt-5.6' });
    expect(findOpenAIModelProfile('vendor/gpt-5.6-sol')).toBeUndefined();
    expect(findOpenAIModelProfile('my-gpt-5.6-sol')).toBeUndefined();
    expect(findOpenAIModelProfile('ft:gpt-5.6-sol:org:custom:id')).toBeUndefined();
    expect(findOpenAIModelProfile('gpt-5.6-sol-custom')).toBeUndefined();
    for (const profile of OPENAI_MODEL_PROFILES) {
      for (const matcher of profile.match) {
        expect(matcher.source.startsWith('^')).toBe(true);
        expect(matcher.source.endsWith('$')).toBe(true);
      }
    }
  });

  it('never applies the catalog to an OpenAI-compatible third-party provider', () => {
    expect(resolveOpenAIModelProfile('GENERIC_OPENAI', 'gpt-5.6-sol')).toBeUndefined();
    expect(resolveOpenAIModelProfile('OPENAI', 'gpt-5.6-sol')).toBeDefined();
  });

  it('fills GPT-5.6 capabilities, reasoning levels and parameter policy without a probe', () => {
    const detection = enrichWithOpenAIOfficialProfile(
      detectModelCapabilities({ id: 'gpt-5.6-sol', object: 'model' }),
      'gpt-5.6-sol',
    );

    expect(detection.capabilities).toEqual({
      chat: true,
      responses: true,
      embeddings: false,
      vision: true,
      tools: true,
      structuredOutput: true,
      streaming: true,
      reasoning: true,
      nativeResponses: true,
    });
    expect(detection.supportedThinkingLevels).toEqual([
      'OFF',
      'LOW',
      'MEDIUM',
      'HIGH',
      'XHIGH',
      'MAX',
    ]);
    expect(detection.parameterSupport).toEqual({ temperature: false });
    expect(detection.evidence.chat).toContainEqual(
      expect.objectContaining({ source: 'official_catalog', state: true }),
    );
  });

  it('keeps explicit upstream declarations and upstream reasoning tiers authoritative', () => {
    const detection = enrichWithOpenAIOfficialProfile(
      detectModelCapabilities({
        id: 'gpt-5.6-sol',
        capabilities: { chat: false, reasoning: { supported: true, levels: ['high'] } },
      }),
      'gpt-5.6-sol',
    );

    expect(detection.capabilities.chat).toBe(false);
    expect(detection.evidence.chat).toEqual([
      expect.objectContaining({ source: 'upstream_metadata', state: false }),
    ]);
    expect(detection.supportedThinkingLevels).toEqual(['HIGH']);
  });

  it('recognizes embedding and specialist families while unknown IDs remain unconfirmed', () => {
    const embedding = enrichWithOpenAIOfficialProfile(
      detectModelCapabilities({ id: 'text-embedding-3-large' }),
      'text-embedding-3-large',
    );
    expect(embedding.capabilities).toMatchObject({ embeddings: true, chat: false });

    const unknown = detectModelCapabilities({ id: 'future-model-1' });
    expect(enrichWithOpenAIOfficialProfile(unknown, 'future-model-1')).toBe(unknown);
  });

  it.each([
    [
      'o3-pro',
      {
        chat: false,
        responses: true,
        vision: true,
        tools: true,
        structuredOutput: true,
        streaming: false,
      },
    ],
    [
      'o3-mini',
      {
        chat: true,
        responses: true,
        vision: false,
        tools: true,
        structuredOutput: true,
        streaming: true,
        nativeResponses: true,
      },
    ],
    [
      'o4-mini',
      {
        chat: true,
        responses: true,
        vision: true,
        tools: true,
        structuredOutput: true,
        streaming: true,
      },
    ],
  ])('keeps the documented capability matrix for %s', (modelId, expected) => {
    expect(findOpenAIModelProfile(modelId)?.capabilities).toMatchObject(expected);
  });

  it.each([
    [
      'o1',
      {
        chat: true,
        responses: true,
        vision: true,
        tools: true,
        structuredOutput: true,
        streaming: true,
      },
    ],
    [
      'o1-preview',
      {
        chat: true,
        responses: false,
        vision: false,
        tools: true,
        structuredOutput: true,
        streaming: true,
        nativeResponses: false,
      },
    ],
    [
      'o1-mini',
      {
        chat: true,
        responses: false,
        vision: false,
        tools: false,
        structuredOutput: false,
        streaming: true,
        nativeResponses: false,
      },
    ],
    [
      'o1-pro',
      {
        chat: false,
        responses: true,
        vision: true,
        tools: true,
        structuredOutput: true,
        streaming: false,
      },
    ],
  ])('does not collapse the distinct legacy reasoning contract for %s', (modelId, expected) => {
    expect(findOpenAIModelProfile(modelId)?.capabilities).toMatchObject(expected);
  });

  it.each(['gpt-5.2-pro', 'gpt-5.4-pro', 'gpt-5.5-pro'])(
    'includes the documented medium reasoning tier for %s',
    (modelId) => {
      expect(findOpenAIModelProfile(modelId)?.supportedThinkingLevels).toEqual([
        'MEDIUM',
        'HIGH',
        'XHIGH',
      ]);
    },
  );

  it('only advertises XHIGH for GPT-5.1 Codex Max', () => {
    expect(findOpenAIModelProfile('gpt-5.1-codex')?.supportedThinkingLevels).toEqual([
      'LOW',
      'MEDIUM',
      'HIGH',
    ]);
    expect(findOpenAIModelProfile('gpt-5.1-codex-mini')?.supportedThinkingLevels).toEqual([
      'LOW',
      'MEDIUM',
      'HIGH',
    ]);
    expect(findOpenAIModelProfile('gpt-5.1-codex-max')?.supportedThinkingLevels).toEqual([
      'LOW',
      'MEDIUM',
      'HIGH',
      'XHIGH',
    ]);
  });

  it.each([
    'gpt-5.1-chat-latest',
    'gpt-5.2-chat-latest',
    'gpt-5.3-chat-latest',
    'gpt-5-chat-latest',
  ])('does not infer configurable reasoning for the ChatGPT snapshot %s', (modelId) => {
    const modelProfile = findOpenAIModelProfile(modelId);
    expect(modelProfile?.capabilities.reasoning).toBe(false);
    expect(modelProfile?.supportedThinkingLevels).toEqual([]);
  });

  it('uses exact deep-research and computer-use contracts without guessed tiers', () => {
    expect(findOpenAIModelProfile('o4-mini-deep-research')).toMatchObject({
      capabilities: {
        chat: false,
        responses: true,
        vision: true,
        tools: false,
        structuredOutput: false,
        streaming: true,
      },
    });
    expect(findOpenAIModelProfile('computer-use-preview')).toMatchObject({
      capabilities: {
        chat: false,
        responses: true,
        vision: true,
        tools: true,
        structuredOutput: false,
        streaming: false,
      },
      supportedThinkingLevels: [],
    });
  });

  it.each([
    ['gpt-4-turbo', { vision: true, tools: true, structuredOutput: false, streaming: true }],
    ['gpt-4', { vision: false, tools: false, structuredOutput: false, streaming: true }],
    ['gpt-3.5-turbo', { vision: false, tools: false, structuredOutput: false, streaming: false }],
  ])('keeps the documented legacy Chat capability matrix for %s', (modelId, expected) => {
    expect(findOpenAIModelProfile(modelId)?.capabilities).toMatchObject({
      chat: true,
      responses: true,
      nativeResponses: true,
      ...expected,
    });
  });

  it.each(['gpt-4-turbo-preview', 'gpt-4-1106-preview', 'gpt-4-0125-preview'])(
    'keeps the text-only GPT-4 Turbo preview %s separate from the vision-capable GA model',
    (modelId) => {
      expect(findOpenAIModelProfile(modelId)).toMatchObject({
        id: 'gpt-4-turbo-preview',
        capabilities: { vision: false },
      });
    },
  );

  it('keeps search-preview and ChatGPT snapshots separate', () => {
    expect(findOpenAIModelProfile('gpt-4o-search-preview')?.capabilities).toMatchObject({
      chat: true,
      responses: false,
      vision: false,
      tools: false,
      structuredOutput: true,
      streaming: true,
      nativeResponses: false,
    });
    expect(findOpenAIModelProfile('chatgpt-4o-latest')?.capabilities).toMatchObject({
      tools: false,
      structuredOutput: false,
    });
    expect(findOpenAIModelProfile('chat-latest')?.capabilities).toMatchObject({
      tools: true,
      structuredOutput: true,
    });
  });

  it('does not advertise image input for the text-only gpt-oss family', () => {
    expect(findOpenAIModelProfile('gpt-oss-20b')?.capabilities).toMatchObject({
      chat: false,
      responses: true,
      vision: false,
      tools: true,
      structuredOutput: true,
      streaming: true,
      reasoning: true,
    });
  });

  it('keeps gpt-audio-mini separate from streaming audio models', () => {
    expect(findOpenAIModelProfile('gpt-audio-mini')?.capabilities).toMatchObject({
      chat: true,
      responses: false,
      vision: false,
      tools: true,
      structuredOutput: false,
      streaming: false,
      nativeResponses: false,
    });
    expect(findOpenAIModelProfile('gpt-audio-1.5')?.capabilities.streaming).toBe(true);
  });

  it.each([
    'omni-moderation-2024-09-26',
    'sora-2-2026-01-01',
    'sora-2-pro-2026-01-01',
    'gpt-4o-mini-tts-2026-01-01',
    'gpt-4-1106-vision-preview',
    'gpt-3.5-turbo-instruct',
  ])('recognizes the unsupported specialist or legacy snapshot %s', (modelId) => {
    expect(findOpenAIModelProfile(modelId)?.id).toBe('router-unsupported-specialists');
  });

  it.each([
    'gpt-5.6-luna',
    'gpt-5.5-pro',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5.2',
    'gpt-5.1-codex-max',
    'gpt-5-mini',
    'o3-pro',
    'o4-mini',
    'o1-preview',
    'gpt-4.1-nano',
    'gpt-4o-mini',
    'gpt-4.5-preview',
    'text-embedding-3-small',
    'gpt-oss-120b',
    'computer-use-preview',
    'o3-deep-research',
    'gpt-image-2',
    'gpt-realtime-2.1-mini',
    'gpt-audio-1.5',
    'gpt-4o-transcribe-diarize',
    'omni-moderation-latest',
    'sora-2-pro',
  ])('contains a versioned profile for the documented %s family', (modelId) => {
    expect(findOpenAIModelProfile(modelId)).toBeDefined();
  });
});

describe('published capability snapshots', () => {
  it('converts every unconfirmed candidate capability to a final false value', () => {
    expect(
      normalizePublishedCapabilities({
        chat: 'unconfirmed',
        responses: true,
        nativeResponses: true,
      }),
    ).toMatchObject({ chat: false, responses: true, nativeResponses: true });
  });

  it('preserves official catalog true values in the final snapshot', () => {
    const detection = enrichWithOpenAIOfficialProfile(
      detectModelCapabilities({ id: 'gpt-5.6-sol' }),
      'gpt-5.6-sol',
    );
    expect(normalizePublishedCapabilities(detection.capabilities)).toMatchObject({
      chat: true,
      responses: true,
      vision: true,
      reasoning: true,
      embeddings: false,
    });
  });
});
