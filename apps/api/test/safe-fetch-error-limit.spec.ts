import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from '../src/config/runtime-config';
import { SafeFetchService } from '../src/gateway/safe-fetch.service';

describe('upstream error body limit', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?schema=app';
    process.env.API_KEY_PEPPER = 'safe-fetch-error-test-pepper';
    process.env.PROVIDER_ENCRYPTION_KEY = 'safe-fetch-error-provider-key';
    process.env.ALLOWED_HTTP_HOSTS = 'ollama';
    loadRuntimeConfig({ refresh: true });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('cancels an oversized non-2xx body after reading at most 16 KiB', async () => {
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('x'.repeat(1024 * 1024)));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 503 },
          ),
      ),
    );

    const service = new SafeFetchService();
    const error = await service
      .fetch(new URL('http://ollama/api/chat'), { method: 'POST' }, 1_000)
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ name: 'ProviderError', status: 503, category: 'http' });
    expect(
      Buffer.byteLength(String((error as { rawBody?: string }).rawBody ?? ''), 'utf8'),
    ).toBeLessThanOrEqual(16 * 1024);
    expect(cancelled).toBe(true);
  });
});
