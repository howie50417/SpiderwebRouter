import { Injectable } from '@nestjs/common';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { loadRuntimeConfig } from '../config/runtime-config';
import { ProviderError, parseRetryAfter } from './provider-error';

@Injectable()
export class SafeFetchService {
  private readonly config = loadRuntimeConfig();

  async fetch(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
    await this.assertSafeDestination(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('upstream timeout')), timeoutMs);
    const externalSignal = init.signal;
    const onAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    let bodyHandedOff = false;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onAbort);
    };
    try {
      const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ProviderError('Upstream redirects are not accepted', {
          status: response.status,
          category: 'security',
          destination: this.destination(url),
        });
      }
      if (!response.ok) {
        const rawBody = await readLimitedText(response.body, 16 * 1024);
        throw new ProviderError('Upstream returned an unsuccessful status', {
          status: response.status,
          category: 'http',
          rawBody,
          upstreamCode: this.extractCode(rawBody),
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          destination: this.destination(url),
        });
      }
      if (!response.body) {
        cleanup();
        return response;
      }
      bodyHandedOff = true;
      return new Response(
        wrapTimedBody(response.body, controller, externalSignal, cleanup, this.destination(url)),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new ProviderError('Upstream request timed out', {
          category: 'timeout',
          destination: this.destination(url),
          cause: error,
        });
      }
      throw new ProviderError('Unable to connect to upstream', {
        category: 'connection',
        destination: this.destination(url),
        cause: error,
      });
    } finally {
      if (!bodyHandedOff) cleanup();
    }
  }

  async assertSafeDestination(url: URL): Promise<void> {
    if (url.username || url.password || url.hash) {
      throw new ProviderError('Provider URL contains forbidden components', {
        category: 'security',
      });
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const internalAllowed =
      this.config.allowedHttpHosts.includes(hostname) && isValidInternalProviderHostname(hostname);
    if (url.protocol === 'http:' && !internalAllowed) {
      throw new ProviderError('Plain HTTP provider is not allowlisted', {
        category: 'security',
        destination: this.destination(url),
      });
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ProviderError('Unsupported provider URL protocol', { category: 'security' });
    }
    if (internalAllowed) return;
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      throw new ProviderError('Local provider address is blocked', { category: 'security' });
    }
    const addresses = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new ProviderError('Private or reserved provider address is blocked', {
        category: 'security',
        destination: this.destination(url),
      });
    }
  }

  private destination(url: URL): string {
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  }

  private extractCode(body: string): string | undefined {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: unknown }; code?: unknown };
      const code = parsed.error?.code ?? parsed.code;
      return typeof code === 'string' || typeof code === 'number'
        ? String(code).slice(0, 100)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

async function readLimitedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        size += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
    if (size >= maxBytes) truncated = true;
  } finally {
    if (truncated) await reader.cancel('upstream error body limit reached').catch(() => undefined);
    else reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function isValidInternalProviderHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return (
    isIP(value) === 0 &&
    value !== 'localhost' &&
    !value.endsWith('.local') &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
  );
}

function wrapTimedBody(
  source: ReadableStream<Uint8Array>,
  abortController: AbortController,
  externalSignal: AbortSignal | null | undefined,
  cleanup: () => void,
  destination: string,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    pull: async (streamController) => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          streamController.close();
        } else {
          streamController.enqueue(value);
        }
      } catch (error) {
        cleanup();
        if (abortController.signal.aborted && !externalSignal?.aborted) {
          streamController.error(
            new ProviderError('Upstream response body timed out', {
              category: 'timeout',
              destination,
              cause: error,
            }),
          );
        } else {
          streamController.error(
            new ProviderError('Upstream response body failed', {
              category: 'connection',
              destination,
              cause: error,
            }),
          );
        }
      }
    },
    cancel: async (reason) => {
      try {
        await reader.cancel(reason);
      } finally {
        cleanup();
      }
    },
  });
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  const mappedHex = /^(?:0:0:0:0:0:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(normalized);
  if (address.toLowerCase().includes('ffff:') && mappedHex) {
    const high = Number.parseInt(mappedHex[1] ?? '0', 16);
    const low = Number.parseInt(mappedHex[2] ?? '0', 16);
    return isPrivateAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
  }
  if (normalized.includes(':')) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('2001:db8:')
    );
  }
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return true;
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
