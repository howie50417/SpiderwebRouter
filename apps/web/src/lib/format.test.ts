import { describe, expect, it } from 'vitest';

import { formatDateTime, formatUsd } from '@/lib/format';

describe('format helpers', () => {
  it('keeps micro-prices visible', () => {
    expect(formatUsd('0.000123', 'en-US')).toContain('0.000123');
  });

  it('returns an em dash for invalid dates', () => {
    expect(formatDateTime('not-a-date', 'en-US')).toBe('—');
    expect(formatDateTime(undefined, 'en-US')).toBe('—');
  });
});
