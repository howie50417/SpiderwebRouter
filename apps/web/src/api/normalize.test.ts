import { describe, expect, it } from 'vitest';

import { normalizeApiPayload, normalizeRequestPayload } from '@/api/normalize';

describe('discovered-model normalization', () => {
  it('preserves supported, unsupported, and unconfirmed capability states', () => {
    const [model] = normalizeApiPayload('/admin/discovered-models', [
      {
        id: 'candidate-1',
        capabilities: {
          chat: true,
          embeddings: false,
          vision: 'unconfirmed',
          responses: 'SUPPORTED',
          nativeResponses: true,
        },
      },
    ]) as Array<Record<string, unknown>>;

    expect(model!.capabilities).toEqual({
      chat: true,
      responses: true,
      embeddings: false,
      vision: 'unconfirmed',
      tools: 'unconfirmed',
      structuredOutput: 'unconfirmed',
      streaming: 'unconfirmed',
      reasoning: 'unconfirmed',
      nativeResponses: true,
    });
    expect(model!.capabilitySource).toBe('UNKNOWN');
  });

  it('derives a mixed source from per-capability evidence', () => {
    const [model] = normalizeApiPayload('/admin/discovered-models', [
      {
        id: 'candidate-1',
        metadata: {
          capabilityEvidence: {
            chat: [
              { source: 'upstream_metadata', path: 'runtimeStatus.capabilities.chat', state: true },
            ],
            responses: [{ source: 'router_emulation', state: true }],
          },
        },
      },
    ]) as Array<Record<string, unknown>>;

    expect(model!.capabilitySource).toBe('MIXED');
  });

  it('keeps only recognized upstream thinking levels', () => {
    const [model] = normalizeApiPayload('/admin/discovered-models', [
      {
        id: 'candidate-1',
        metadata: {
          supportedThinkingLevels: ['OFF', 'HIGH', 'MAX', 'turbo', 3],
        },
      },
    ]) as Array<Record<string, unknown>>;

    expect(model!.metadata).toEqual({ supportedThinkingLevels: ['OFF', 'HIGH', 'MAX'] });
  });

  it('recognizes official catalog evidence without pretending it came from provider metadata', () => {
    const [model] = normalizeApiPayload('/admin/discovered-models', [
      {
        id: 'candidate-1',
        metadata: {
          capabilityEvidence: {
            reasoning: [{ source: 'official_catalog', profile: 'openai:gpt-5.6' }],
          },
        },
      },
    ]) as Array<Record<string, unknown>>;

    expect(model!.capabilitySource).toBe('OFFICIAL_CATALOG');
  });
});

describe('customer model normalization', () => {
  it('preserves safe Thinking and parameter support policy', () => {
    const [model] = normalizeApiPayload('/me/models', [
      {
        id: 'grant-1',
        alias: 'gpt-5.6-sol',
        capabilities: { chat: true, reasoning: true },
        thinkingControlMode: 'USER_SELECTABLE',
        supportedThinkingLevels: ['OFF', 'LOW', 'MAX', 'PROVIDER_DEFAULT', 'invalid'],
        parameterSupport: { temperature: false },
      },
    ]) as Array<Record<string, unknown>>;

    expect(model).toMatchObject({
      name: 'gpt-5.6-sol',
      thinkingControlMode: 'USER_SELECTABLE',
      supportedThinkingLevels: ['OFF', 'LOW', 'MAX'],
      parameterSupport: { temperature: false },
    });
  });
});

describe('batch grant normalization', () => {
  const path = '/admin/users/user-1/grants/batch';

  it('does not reinterpret the batch request as a user update', () => {
    expect(normalizeRequestPayload(path, { publishedModelIds: ['model-1', 'model-2'] })).toEqual({
      publishedModelIds: ['model-1', 'model-2'],
    });
  });

  it('preserves the batch summary and normalizes returned grants', () => {
    expect(
      normalizeApiPayload(path, {
        userId: 'user-1',
        created: 1,
        skippedExisting: 0,
        grants: [
          {
            id: 'grant-1',
            alias: 'upstream/model',
            active: true,
            customInputPricePerM: null,
            customOutputPricePerM: '2',
          },
        ],
      }),
    ).toMatchObject({
      userId: 'user-1',
      created: 1,
      skippedExisting: 0,
      grants: [
        {
          id: 'grant-1',
          alias: 'upstream/model',
          enabled: true,
          customInputPriceUsdPerMillion: null,
          customOutputPriceUsdPerMillion: '2',
        },
      ],
    });
  });
});

describe.each(['/me/usage', '/admin/usage'])('usage normalization for %s', (path) => {
  it('preserves request timestamps used by the shared usage table', () => {
    const createdAt = '2026-08-09T11:52:21.970Z';
    const completedAt = '2026-08-09T11:52:23.708Z';
    const payload = normalizeApiPayload(path, {
      data: [
        {
          id: 'usage-1',
          requestId: 'request-1',
          endpoint: 'responses',
          modelAlias: 'DeepSeek-V4-Flash-0731',
          createdAt,
          completedAt,
        },
      ],
    }) as { data: Array<Record<string, unknown>> };

    expect(payload.data[0]).toMatchObject({ createdAt, completedAt });
  });
});
