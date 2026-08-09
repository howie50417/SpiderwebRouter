import { describe, expect, it } from 'vitest';

import { isValidModelAlias } from '@/lib/modelAlias';

describe('model alias validation', () => {
  it('accepts namespaced upstream-style aliases', () => {
    expect(isValidModelAlias('unsloth/DeepSeek-V4-Flash-0731-GGUF')).toBe(true);
  });

  it('continues to accept the existing alias characters', () => {
    expect(isValidModelAlias('provider:model.v2_test-fast')).toBe(true);
  });

  it('rejects whitespace and URL control characters', () => {
    expect(isValidModelAlias('model name')).toBe(false);
    expect(isValidModelAlias('model?revision=main')).toBe(false);
    expect(isValidModelAlias('model#revision')).toBe(false);
  });
});
