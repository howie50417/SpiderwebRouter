import type { ProviderType, PublishedModel } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { prepareRequestBody, stripClientThinking } from '../src/gateway/request-transform';

function model(overrides: Partial<PublishedModel> = {}): PublishedModel {
  return {
    upstreamModelId: 'private-upstream-model',
    promptMode: 'NONE',
    systemPrompt: null,
    thinkingLevel: 'PROVIDER_DEFAULT',
    ...overrides,
  } as unknown as PublishedModel;
}

describe('client thinking controls', () => {
  it('removes every supported top-level control without corrupting nested payload data', () => {
    expect(
      stripClientThinking({
        reasoning: { effort: 'high' },
        reasoning_effort: 'high',
        thinking: true,
        thinking_config: { budget: 10 },
        thinkingConfig: { budget: 10 },
        think: 'high',
        messages: [{ role: 'user', content: 'hello', reasoning_effort: 'high' }],
      }),
    ).toEqual({ messages: [{ role: 'user', content: 'hello', reasoning_effort: 'high' }] });
  });

  it('overrides Responses reasoning with the server policy without mutating input', () => {
    const source = {
      model: 'public-alias',
      input: 'hello',
      reasoning: { effort: 'low', summary: 'detailed' },
    };

    const result = prepareRequestBody(
      source,
      'responses',
      model({ thinkingLevel: 'HIGH' }),
      'OPENAI',
    );

    expect(result).toMatchObject({
      model: 'private-upstream-model',
      input: 'hello',
      reasoning: { effort: 'high' },
    });
    expect(source.reasoning).toEqual({ effort: 'low', summary: 'detailed' });
  });

  it.each<[ProviderType, unknown]>([
    ['OLLAMA', false],
    ['GENERIC_OPENAI', undefined],
  ])('applies OFF thinking policy for %s', (providerType, expectedThink) => {
    const result = prepareRequestBody(
      { model: 'alias', messages: [{ role: 'user', content: 'hello' }], think: true },
      'chat',
      model({ thinkingLevel: 'OFF' }),
      providerType,
    );

    if (providerType === 'OLLAMA') {
      expect(result.think).toBe(expectedThink);
      expect(result).not.toHaveProperty('reasoning_effort');
    } else {
      expect(result.reasoning_effort).toBe('none');
      expect(result).not.toHaveProperty('think');
    }
  });

  it.each(['MINIMAL', 'XHIGH', 'MAX'] as const)(
    'passes the %s server-only reasoning effort to an OpenAI-compatible provider',
    (thinkingLevel) => {
      const result = prepareRequestBody(
        { model: 'alias', messages: [{ role: 'user', content: 'hello' }] },
        'chat',
        model({ thinkingLevel }),
        'GENERIC_OPENAI',
      );

      expect(result.reasoning_effort).toBe(thinkingLevel.toLowerCase());
    },
  );

  it('uses the closest OpenAI-supported effort when the server policy is OFF', () => {
    const result = prepareRequestBody(
      { model: 'alias', input: 'hello' },
      'responses',
      model({ thinkingLevel: 'OFF' }),
      'OPENAI',
    );

    expect(result.reasoning).toEqual({ effort: 'minimal' });
  });

  it('uses none for OFF-capable GPT-5.1+ profiles while retaining the GPT-5 minimal wire value', () => {
    const gpt56 = prepareRequestBody(
      { model: 'alias', input: 'hello' },
      'responses',
      model({ upstreamModelId: 'gpt-5.6-sol', thinkingLevel: 'OFF' }),
      'OPENAI',
    );
    const gpt55 = prepareRequestBody(
      { model: 'alias', input: 'hello' },
      'responses',
      model({ upstreamModelId: 'gpt-5.5', thinkingLevel: 'OFF' }),
      'OPENAI',
    );
    const gpt54 = prepareRequestBody(
      { model: 'alias', input: 'hello' },
      'responses',
      model({ upstreamModelId: 'gpt-5.4', thinkingLevel: 'OFF' }),
      'OPENAI',
    );
    const gpt52 = prepareRequestBody(
      { model: 'alias', input: 'hello' },
      'responses',
      model({ upstreamModelId: 'gpt-5.2', thinkingLevel: 'OFF' }),
      'OPENAI',
    );
    const gpt51 = prepareRequestBody(
      { model: 'alias', input: 'hello' },
      'responses',
      model({ upstreamModelId: 'gpt-5.1', thinkingLevel: 'OFF' }),
      'OPENAI',
    );
    const gpt5 = prepareRequestBody(
      { model: 'alias', input: 'hello' },
      'responses',
      model({ upstreamModelId: 'gpt-5', thinkingLevel: 'OFF' }),
      'OPENAI',
    );
    const compatible = prepareRequestBody(
      { model: 'alias', input: 'hello' },
      'responses',
      model({ upstreamModelId: 'gpt-5.6-sol', thinkingLevel: 'OFF' }),
      'GENERIC_OPENAI',
    );

    expect(gpt56.reasoning).toEqual({ effort: 'none' });
    expect(gpt55.reasoning).toEqual({ effort: 'none' });
    expect(gpt54.reasoning).toEqual({ effort: 'none' });
    expect(gpt52.reasoning).toEqual({ effort: 'none' });
    expect(gpt51.reasoning).toEqual({ effort: 'none' });
    expect(gpt5.reasoning).toEqual({ effort: 'minimal' });
    expect(compatible.reasoning).toEqual({ effort: 'none' });
  });

  it.each(['chat', 'responses'] as const)(
    'silently strips GPT-5.6 temperature for %s, including streaming requests',
    (operation) => {
      const source =
        operation === 'chat'
          ? {
              model: 'alias',
              messages: [{ role: 'user', content: 'hello' }],
              temperature: 0.7,
              stream: true,
            }
          : { model: 'alias', input: 'hello', temperature: 0.7, stream: true };
      const result = prepareRequestBody(
        source,
        operation,
        model({ upstreamModelId: 'gpt-5.6-terra' }),
        'OPENAI',
      );
      expect(result).not.toHaveProperty('temperature');
      expect(source.temperature).toBe(0.7);
    },
  );

  it('retains temperature for older and third-party models', () => {
    expect(
      prepareRequestBody(
        { messages: [{ role: 'user', content: 'hello' }], temperature: 0.2 },
        'chat',
        model({ upstreamModelId: 'gpt-4o' }),
        'OPENAI',
      ).temperature,
    ).toBe(0.2);
    expect(
      prepareRequestBody(
        { messages: [{ role: 'user', content: 'hello' }], temperature: 0.3 },
        'chat',
        model({ upstreamModelId: 'gpt-5.6-sol' }),
        'GENERIC_OPENAI',
      ).temperature,
    ).toBe(0.3);
  });

  it('ignores malformed client thinking in FIXED mode before applying the server policy', () => {
    const result = prepareRequestBody(
      {
        messages: [{ role: 'user', content: 'hello' }],
        reasoning_effort: { malicious: true },
        thinkingConfig: { thinkingBudget: -1 },
      },
      'chat',
      model({ thinkingControlMode: 'FIXED', thinkingLevel: 'HIGH' }),
      'OPENAI',
    );
    expect(result.reasoning_effort).toBe('high');
    expect(result).not.toHaveProperty('thinkingConfig');
  });

  it('allows only confirmed canonical thinking controls in USER_SELECTABLE mode', () => {
    const selectable = model({
      thinkingControlMode: 'USER_SELECTABLE',
      supportedThinkingLevels: ['OFF', 'HIGH'],
      thinkingLevel: 'LOW',
    });
    const chat = prepareRequestBody(
      { messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'high' },
      'chat',
      selectable,
      'OPENAI',
    );
    const responses = prepareRequestBody(
      { input: 'hello', reasoning: { effort: 'none' } },
      'responses',
      model({
        ...selectable,
        upstreamModelId: 'gpt-5.6-sol',
      }),
      'OPENAI',
    );
    const providerDefault = prepareRequestBody(
      { input: 'hello' },
      'responses',
      selectable,
      'OPENAI',
    );

    expect(chat.reasoning_effort).toBe('high');
    expect(responses.reasoning).toEqual({ effort: 'none' });
    expect(providerDefault).not.toHaveProperty('reasoning');
    expect(() =>
      prepareRequestBody(
        { messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'low' },
        'chat',
        selectable,
        'OPENAI',
      ),
    ).toThrowError(/reasoning effort is not available/i);
  });

  it('ignores non-canonical controls in USER_SELECTABLE mode', () => {
    const selectable = model({
      thinkingControlMode: 'USER_SELECTABLE',
      supportedThinkingLevels: ['HIGH'],
    });
    const chat = prepareRequestBody(
      {
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: { effort: 'high' },
        thinking: 'high',
      },
      'chat',
      selectable,
      'OPENAI',
    );
    const responses = prepareRequestBody(
      { input: 'hello', reasoning_effort: 'high', thinkingConfig: { level: 'high' } },
      'responses',
      selectable,
      'OPENAI',
    );
    expect(chat).not.toHaveProperty('reasoning');
    expect(chat).not.toHaveProperty('reasoning_effort');
    expect(chat).not.toHaveProperty('thinking');
    expect(responses).not.toHaveProperty('reasoning');
    expect(responses).not.toHaveProperty('reasoning_effort');
    expect(responses).not.toHaveProperty('thinkingConfig');
  });

  it('passes a server-only thinking marker to the Gemini adapter', () => {
    const result = prepareRequestBody(
      {
        model: 'alias',
        messages: [{ role: 'user', content: 'hello' }],
        thinkingConfig: { thinkingBudget: 0 },
      },
      'chat',
      model({ thinkingLevel: 'MEDIUM' }),
      'GEMINI',
    );

    expect(result._serverThinkingLevel).toBe('MEDIUM');
    expect(result).not.toHaveProperty('thinkingConfig');
  });
});

describe('system prompt policy', () => {
  it('leaves messages unchanged in NONE mode', () => {
    const messages = [
      { role: 'system', content: 'customer system' },
      { role: 'user', content: 'hello' },
    ];

    const result = prepareRequestBody({ model: 'alias', messages }, 'chat', model(), 'OPENAI');

    expect(result.messages).toEqual(messages);
  });

  it('prepends the platform system prompt while preserving customer messages', () => {
    const result = prepareRequestBody(
      {
        model: 'alias',
        messages: [
          { role: 'system', content: 'customer system' },
          { role: 'user', content: 'hello' },
        ],
      },
      'chat',
      model({ promptMode: 'PREPEND', systemPrompt: 'platform system' }),
      'OPENAI',
    );

    expect(result.messages).toEqual([
      { role: 'system', content: 'platform system' },
      { role: 'system', content: 'customer system' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('replaces all customer system and developer messages', () => {
    const result = prepareRequestBody(
      {
        model: 'alias',
        messages: [
          { role: 'system', content: 'customer system' },
          { role: 'developer', content: 'customer developer' },
          { role: 'user', content: 'hello' },
        ],
      },
      'chat',
      model({ promptMode: 'REPLACE', systemPrompt: 'platform only' }),
      'OPENAI',
    );

    expect(result.messages).toEqual([
      { role: 'system', content: 'platform only' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it.each([
    ['PREPEND', 'platform instructions\n\ncustomer instructions'],
    ['REPLACE', 'platform instructions'],
  ] as const)('applies %s mode to Responses instructions', (promptMode, instructions) => {
    const result = prepareRequestBody(
      { model: 'alias', input: 'hello', instructions: 'customer instructions' },
      'responses',
      model({ promptMode, systemPrompt: 'platform instructions' }),
      'OPENAI',
    );

    expect(result.instructions).toBe(instructions);
  });

  it('never injects a system prompt or thinking into embeddings', () => {
    const result = prepareRequestBody(
      { model: 'alias', input: ['hello'] },
      'embeddings',
      model({ promptMode: 'REPLACE', systemPrompt: 'must not appear', thinkingLevel: 'HIGH' }),
      'OPENAI',
    );

    expect(JSON.stringify(result)).not.toContain('must not appear');
    expect(result).not.toHaveProperty('reasoning');
  });
});
