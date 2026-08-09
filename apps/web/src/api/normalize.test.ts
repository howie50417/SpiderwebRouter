import { describe, expect, it } from 'vitest';

import { normalizeApiPayload } from '@/api/normalize';

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
});
