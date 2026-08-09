import { describe, expect, it } from 'vitest';
import {
  isRetryableProviderError,
  parseRetryAfter,
  ProviderError,
  retryDelayMs,
} from '../src/gateway/provider-error';

describe('provider retry eligibility', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %s', (status) => {
    expect(
      isRetryableProviderError(new ProviderError('failed', { category: 'http', status })),
    ).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])('does not retry HTTP %s', (status) => {
    expect(
      isRetryableProviderError(new ProviderError('failed', { category: 'http', status })),
    ).toBe(false);
  });

  it.each(['timeout', 'connection'] as const)('retries %s failures', (category) => {
    expect(isRetryableProviderError(new ProviderError('failed', { category }))).toBe(true);
  });

  it.each(['protocol', 'security'] as const)('does not retry %s failures', (category) => {
    expect(isRetryableProviderError(new ProviderError('failed', { category }))).toBe(false);
  });
});

describe('Retry-After and exponential backoff', () => {
  it('parses delta seconds and HTTP dates, rejecting invalid values', () => {
    const now = Date.parse('2026-08-09T00:00:00Z');

    expect(parseRetryAfter('2.5', now)).toBe(2_500);
    expect(parseRetryAfter('Sun, 09 Aug 2026 00:00:03 GMT', now)).toBe(3_000);
    expect(parseRetryAfter('not-a-date', now)).toBeUndefined();
    expect(parseRetryAfter('-1', now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('caps unreasonable Retry-After values and each actual delay', () => {
    expect(parseRetryAfter('300')).toBe(30_000);
    expect(retryDelayMs(1, 30_000, () => 1)).toBe(5_000);
    expect(retryDelayMs(99, undefined, () => 1)).toBeLessThanOrEqual(5_000);
  });

  it('uses exponential backoff with deterministic jitter', () => {
    expect(retryDelayMs(1, undefined, () => 0)).toBe(375);
    expect(retryDelayMs(1, undefined, () => 0.5)).toBe(500);
    expect(retryDelayMs(2, undefined, () => 0.5)).toBe(1_000);
    expect(retryDelayMs(4, undefined, () => 0.5)).toBe(4_000);
  });
});

describe('provider error diagnostics', () => {
  it('redacts and truncates the upstream body at construction time', () => {
    const error = new ProviderError('failed', {
      category: 'http',
      rawBody: `authorization: Bearer private-token ${'x'.repeat(20_000)}`,
    });

    expect(error.rawBody).not.toContain('private-token');
    expect(error.rawBody?.length).toBeLessThanOrEqual(16 * 1024);
  });
});
