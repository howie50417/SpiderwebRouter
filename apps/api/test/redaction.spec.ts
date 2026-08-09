import { describe, expect, it } from 'vitest';
import { redactText, safeLogObject } from '../src/common/logger';
import { AppError, errorEnvelope } from '../src/common/errors';

describe('safe errors and logging', () => {
  it('redacts common bearer and API key formats', () => {
    const redacted = redactText('Authorization: Bearer secret-value sk-exampleSecret123456');
    expect(redacted).not.toContain('secret-value');
    expect(redacted).not.toContain('sk-exampleSecret123456');
  });

  it('removes content-bearing fields recursively', () => {
    const value = safeLogObject({
      status: 500,
      nested: { prompt: 'private', token: 'private', code: 'boom' },
    });
    expect(value).toEqual({
      status: 500,
      nested: { prompt: '[REDACTED]', token: '[REDACTED]', code: 'boom' },
    });
  });

  it('uses only system-owned public error fields', () => {
    const result = errorEnvelope(new AppError('provider_unavailable', 503), 'request-123');
    expect(result.error).toEqual({
      message: 'The model service is temporarily unavailable.',
      type: 'invalid_request_error',
      param: null,
      code: 'provider_unavailable',
      request_id: 'request-123',
    });
  });
});
