import { redactText } from '../common/logger';

export interface ProviderErrorOptions {
  status?: number;
  category: 'http' | 'timeout' | 'connection' | 'protocol' | 'security';
  upstreamCode?: string;
  retryAfterMs?: number;
  rawBody?: string;
  destination?: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly status?: number;
  readonly category: ProviderErrorOptions['category'];
  readonly upstreamCode?: string;
  readonly retryAfterMs?: number;
  readonly rawBody?: string;
  readonly destination?: string;
  override readonly cause?: unknown;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = 'ProviderError';
    this.status = options.status;
    this.category = options.category;
    this.upstreamCode = options.upstreamCode;
    this.retryAfterMs = options.retryAfterMs;
    this.rawBody = options.rawBody ? redactText(options.rawBody) : undefined;
    this.destination = options.destination;
    this.cause = options.cause;
  }
}

export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryableProviderError(error: ProviderError): boolean {
  if (error.category === 'timeout' || error.category === 'connection') return true;
  return error.status !== undefined && RETRYABLE_STATUS.has(error.status);
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(date - now, 30_000));
}

export function retryDelayMs(
  attemptNumber: number,
  retryAfterMs?: number,
  random = Math.random,
): number {
  if (retryAfterMs !== undefined) return Math.min(Math.max(0, retryAfterMs), 5_000);
  const base = Math.min(500 * 2 ** Math.max(0, attemptNumber - 1), 5_000);
  return Math.min(5_000, Math.round(base * (0.75 + random() * 0.5)));
}
