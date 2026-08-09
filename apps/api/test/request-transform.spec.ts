import { describe, expect, it } from 'vitest';
import type { PublishedModel } from '@prisma/client';
import { prepareRequestBody } from '../src/gateway/request-transform';

function model(overrides: Partial<PublishedModel> = {}): PublishedModel {
  return {
    id: 'model-id',
    providerId: 'provider-id',
    upstreamModelId: 'private-upstream',
    defaultAlias: 'public-model',
    displayName: null,
    active: true,
    capabilities: {},
    promptMode: 'NONE',
    systemPrompt: null,
    thinkingLevel: 'PROVIDER_DEFAULT',
    maxRetries: 0,
    inputPricePerM: {} as PublishedModel['inputPricePerM'],
    outputPricePerM: {} as PublishedModel['outputPricePerM'],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe('server-owned model settings', () => {
  it('replaces client reasoning and prepends the configured prompt', () => {
    const result = prepareRequestBody(
      {
        model: 'public-model',
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'hello' }],
      },
      'chat',
      model({ promptMode: 'PREPEND', systemPrompt: 'policy', thinkingLevel: 'LOW' }),
      'OPENAI',
    );
    expect(result.model).toBe('private-upstream');
    expect(result.reasoning_effort).toBe('low');
    expect(result.messages).toEqual([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('replaces existing system and developer messages', () => {
    const result = prepareRequestBody(
      {
        messages: [
          { role: 'system', content: 'client' },
          { role: 'developer', content: 'client' },
          { role: 'user', content: 'hello' },
        ],
      },
      'chat',
      model({ promptMode: 'REPLACE', systemPrompt: 'server' }),
      'GENERIC_OPENAI',
    );
    expect(result.messages).toEqual([
      { role: 'system', content: 'server' },
      { role: 'user', content: 'hello' },
    ]);
  });
});
