import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from '../src/config/runtime-config';
import { SafeFetchService } from '../src/gateway/safe-fetch.service';

describe('upstream streaming deadline', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?schema=app';
    process.env.API_KEY_PEPPER = 'stream-timeout-test-pepper';
    process.env.PROVIDER_ENCRYPTION_KEY = 'stream-timeout-provider-key';
    process.env.ALLOWED_HTTP_HOSTS = 'ollama';
    loadRuntimeConfig({ refresh: true });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps the timeout active after headers while the first body frame never arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }),
    );
    const service = new SafeFetchService();
    const response = await service.fetch(new URL('http://ollama/api/chat'), { method: 'POST' }, 25);
    const reader = response.body!.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProviderError',
      category: 'timeout',
    });
  });
});
