import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AppError, errorEnvelope, type PublicErrorCode } from '../src/common/errors';
import { SafeExceptionFilter } from '../src/common/exception.filter';
import { appLogger, redactText, safeLogObject } from '../src/common/logger';
import { ProviderError } from '../src/gateway/provider-error';

describe('public error envelopes', () => {
  it.each<[PublicErrorCode, string]>([
    ['invalid_request_error', 'invalid_request_error'],
    ['authentication_error', 'authentication_error'],
    ['permission_denied', 'permission_error'],
    ['model_not_found', 'invalid_request_error'],
    ['unsupported_feature', 'invalid_request_error'],
    ['rate_limit_error', 'rate_limit_error'],
    ['provider_unavailable', 'invalid_request_error'],
    ['upstream_timeout', 'invalid_request_error'],
    ['internal_error', 'server_error'],
  ])('maps %s to a stable OpenAI-compatible type', (code, type) => {
    const result = errorEnvelope(new AppError(code, 500), 'req-public-1');

    expect(result).toEqual({
      error: {
        message: expect.any(String),
        type,
        param: null,
        code,
        request_id: 'req-public-1',
      },
    });
  });

  it('never serializes the diagnostic cause', () => {
    const diagnostic = new ProviderError('provider host and model failed', {
      category: 'http',
      status: 503,
      destination: 'secret-provider.example/v1/chat/completions',
      rawBody: '{"error":"upstream-secret"}',
    });
    const serialized = JSON.stringify(
      errorEnvelope(
        new AppError('provider_unavailable', 503, undefined, null, diagnostic),
        'req-safe',
      ),
    );

    expect(serialized).not.toContain('secret-provider');
    expect(serialized).not.toContain('upstream-secret');
    expect(serialized).toContain('provider_unavailable');
  });
});

describe('diagnostic redaction', () => {
  it('redacts bearer credentials, API keys, cookies and provider secrets', () => {
    const value = [
      'Authorization: Bearer top-secret-token',
      'api_key=sk-exampleCredential123456',
      'cookie=session-value',
      'token: AIzaExampleCredential1234567890',
      'temporaryPassword=one-time-password-value',
    ].join('; ');

    const redacted = redactText(value);

    expect(redacted).not.toContain('top-secret-token');
    expect(redacted).not.toContain('sk-exampleCredential123456');
    expect(redacted).not.toContain('session-value');
    expect(redacted).not.toContain('AIzaExampleCredential1234567890');
    expect(redacted).not.toContain('one-time-password-value');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts secrets and content fields from JSON-shaped upstream errors', () => {
    const upstreamBody = JSON.stringify({
      error: {
        authorization: 'Bearer opaque-credential',
        api_key: 'opaque-api-credential',
        token: 'opaque-token',
        cookie: 'opaque-session',
        password: 'private-password',
        credentials: 'private-credentials',
        prompt: 'private customer prompt',
        messages: [{ role: 'user', content: 'private customer message' }],
        input: 'private Responses input',
        tool_arguments: { city: 'private tool payload' },
      },
    });

    const redacted = redactText(upstreamBody);

    for (const forbidden of [
      'opaque-credential',
      'opaque-api-credential',
      'opaque-token',
      'opaque-session',
      'private-password',
      'private-credentials',
      'private customer prompt',
      'private customer message',
      'private Responses input',
      'private tool payload',
    ]) {
      expect(redacted).not.toContain(forbidden);
    }
  });

  it('redacts sensitive object fields recursively without losing diagnostics', () => {
    const redacted = safeLogObject({
      status: 503,
      provider: { id: 'provider-id', token: 'provider-token' },
      credential: { temporaryPassword: 'generated-password' },
      request: {
        headers: { authorization: 'Bearer hidden', 'content-type': 'application/json' },
        messages: [{ role: 'user', content: 'private prompt' }],
      },
      toolArguments: { password: 'private tool payload' },
    });

    expect(redacted).toEqual({
      status: 503,
      provider: { id: 'provider-id', token: '[REDACTED]' },
      credential: '[REDACTED]',
      request: {
        headers: { authorization: '[REDACTED]', 'content-type': 'application/json' },
        messages: '[REDACTED]',
      },
      toolArguments: '[REDACTED]',
    });
  });

  it('truncates an upstream body before it can flood logs', () => {
    expect(redactText('x'.repeat(20_000))).toHaveLength(16 * 1024);
    expect(Buffer.byteLength(redactText('\u6e2c'.repeat(20_000)), 'utf8')).toBeLessThanOrEqual(
      16 * 1024,
    );
  });
});

describe('global exception filter', () => {
  it('returns only an internal envelope for an unexpected provider exception', () => {
    const reply = {
      sent: false,
      header: vi.fn(),
      status: vi.fn(),
      send: vi.fn(),
    };
    reply.header.mockReturnValue(reply);
    reply.status.mockReturnValue(reply);
    const request = { id: 'req-filter', method: 'POST', url: '/v1/responses?debug=true' };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;
    const log = vi.spyOn(appLogger, 'error').mockImplementation(() => undefined);
    const upstream = new ProviderError('SDK says provider/model/url failed', {
      category: 'http',
      status: 502,
      destination: 'private-upstream.example/v1/responses',
      rawBody: '{"api_key":"sk-exampleCredential123456","detail":"private"}',
    });

    new SafeExceptionFilter().catch(upstream, host);

    expect(reply.header).toHaveBeenCalledWith('x-request-id', 'req-filter');
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        message: 'An internal error occurred.',
        type: 'server_error',
        param: null,
        code: 'internal_error',
        request_id: 'req-filter',
      },
    });
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('private-upstream');
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('sk-exampleCredential123456');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: 'req-filter' }),
      'request_failed',
    );
  });
});
