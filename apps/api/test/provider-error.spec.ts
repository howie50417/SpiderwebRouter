import { describe, expect, it } from 'vitest';
import {
  isRetryableProviderError,
  parseRetryAfter,
  ProviderError,
  retryDelayMs,
} from '../src/gateway/provider-error';

describe('provider retry policy', () => {
  it('retries only transient statuses and network failures', () => {
    expect(
      isRetryableProviderError(new ProviderError('busy', { category: 'http', status: 429 })),
    ).toBe(true);
    expect(
      isRetryableProviderError(new ProviderError('bad gateway', { category: 'http', status: 502 })),
    ).toBe(true);
    expect(
      isRetryableProviderError(
        new ProviderError('unauthorized', { category: 'http', status: 401 }),
      ),
    ).toBe(false);
    expect(
      isRetryableProviderError(new ProviderError('bad request', { category: 'http', status: 400 })),
    ).toBe(false);
    expect(isRetryableProviderError(new ProviderError('timeout', { category: 'timeout' }))).toBe(
      true,
    );
  });

  it('clamps jittered exponential backoff to five seconds', () => {
    expect(retryDelayMs(1, undefined, () => 0)).toBe(375);
    expect(retryDelayMs(10, undefined, () => 1)).toBe(5000);
    expect(retryDelayMs(1, 9000)).toBe(5000);
  });

  it('parses seconds and dates from Retry-After', () => {
    expect(parseRetryAfter('2', 0)).toBe(2000);
    expect(parseRetryAfter(new Date(3000).toUTCString(), 0)).toBe(3000);
    expect(parseRetryAfter('invalid', 0)).toBeUndefined();
  });
});
