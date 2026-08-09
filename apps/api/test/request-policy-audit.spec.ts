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
