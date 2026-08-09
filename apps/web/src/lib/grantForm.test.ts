import { describe, expect, it } from 'vitest';

import { optionalGrantAlias, ungrantedModelIds } from '@/lib/grantForm';

describe('optionalGrantAlias', () => {
  it('omits an empty alias so the server can use the upstream model ID', () => {
    expect(optionalGrantAlias(undefined)).toBeUndefined();
    expect(optionalGrantAlias('   ')).toBeUndefined();
  });

  it('trims a custom alias without changing its model namespace', () => {
    expect(optionalGrantAlias('  unsloth/DeepSeek-V4  ')).toBe('unsloth/DeepSeek-V4');
  });
});

describe('ungrantedModelIds', () => {
  it('keeps only unique models that are not already granted', () => {
    expect(ungrantedModelIds(['a', 'b', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });
});
