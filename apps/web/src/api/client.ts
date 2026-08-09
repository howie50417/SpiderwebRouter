import type { ControlPlaneErrorEnvelope, PublicErrorCode } from '@spiderwebrouter/contracts';

import type { ListQuery, PageResult } from '@/types';
import { normalizeApiPayload, normalizeRequestPayload } from '@/api/normalize';

const API_BASE = '/api';

const publicMessages: Partial<Record<PublicErrorCode, string>> = {
  invalid_request_error: 'Some submitted values are invalid.',
  authentication_error: 'Your session has expired. Please sign in again.',
  permission_denied: 'You do not have permission to perform this action.',
  model_not_found: 'The selected model is not available.',
  unsupported_feature: 'This model does not support the requested feature.',
  rate_limit_error: 'The service is busy. Please try again shortly.',
  provider_unavailable: 'The model service is temporarily unavailable.',
  upstream_timeout: 'The model service took too long to respond.',
  internal_error: 'An unexpected error occurred. Please try again.',
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: PublicErrorCode;
  readonly requestId?: string;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(options: {
    status: number;
    code?: PublicErrorCode;
    requestId?: string;
    fieldErrors?: Record<string, string[]>;
  }) {
    const code = options.code ?? 'internal_error';
    super(publicMessages[code] ?? publicMessages.internal_error);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = code;
    this.requestId = options.requestId;
    this.fieldErrors = options.fieldErrors;
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  query?: ListQuery;
};

function withQuery(path: string, query?: ListQuery): string {
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }
  return `${url.pathname}${url.search}`;
}

function isErrorCode(value: unknown): value is PublicErrorCode {
  return typeof value === 'string' && value in publicMessages;
}

async function parseSafeError(response: Response): Promise<ApiError> {
  let payload: Partial<ControlPlaneErrorEnvelope> | undefined;
  let nested: Record<string, unknown> | undefined;
  try {
    const raw = (await response.json()) as Record<string, unknown>;
    payload = raw as Partial<ControlPlaneErrorEnvelope>;
    nested =
      raw.error && typeof raw.error === 'object'
        ? (raw.error as Record<string, unknown>)
        : undefined;
  } catch {
    payload = undefined;
  }

  return new ApiError({
    status: response.status,
    code: isErrorCode(payload?.code)
      ? payload.code
      : isErrorCode(nested?.code)
        ? nested.code
        : 'internal_error',
    requestId:
      typeof payload?.requestId === 'string'
        ? payload.requestId
        : typeof nested?.request_id === 'string'
          ? nested.request_id
          : (response.headers.get('x-request-id') ?? undefined),
    fieldErrors:
      payload?.fieldErrors && typeof payload.fieldErrors === 'object'
        ? payload.fieldErrors
        : undefined,
  });
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  headers.set('X-Requested-With', 'SpiderwebRouterConsole');

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(normalizeRequestPayload(path, options.body));
  }

  let response: Response;
  try {
    response = await fetch(withQuery(path, options.query), {
      ...options,
      body,
      credentials: 'include',
      headers,
    });
  } catch {
    throw new ApiError({ status: 0, code: 'provider_unavailable' });
  }

  if (!response.ok) {
    throw await parseSafeError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return (await response.text()) as T;
  }
  return normalizeApiPayload(path, await response.json()) as T;
}

function normalizePage<T>(payload: unknown, query?: ListQuery): PageResult<T> {
  if (Array.isArray(payload)) {
    const filtered = filterLocalCollection(payload as T[], query);
    const page = positiveInteger(query?.page, 1);
    const pageSize = positiveInteger(query?.pageSize, Math.max(filtered.length, 1));
    const start = (page - 1) * pageSize;
    return {
      data: filtered.slice(start, start + pageSize),
      total: filtered.length,
    };
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const data = Array.isArray(record.data)
      ? (record.data as T[])
      : Array.isArray(record.items)
        ? (record.items as T[])
        : [];
    const total = typeof record.total === 'number' ? record.total : data.length;
    return { data, total };
  }
  return { data: [], total: 0 };
}

async function list<T>(path: string, query?: ListQuery): Promise<PageResult<T>> {
  const payload = await request<unknown>(path, { query });
  return normalizePage<T>(payload, query);
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function filterLocalCollection<T>(items: T[], query?: ListQuery): T[] {
  if (!query) return items;
  const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
  const from = parseDate(query.from);
  const to = parseDate(query.to, true);
  const ignored = new Set([
    'page',
    'pageSize',
    'search',
    'sort',
    'order',
    'from',
    'to',
    'summary',
    'series',
    'range',
  ]);
  const aliases: Record<string, string[]> = {
    actor: ['actorEmail'],
    apiKey: ['apiKeyName', 'apiKeyId'],
    kind: ['kind', 'endpoint'],
    model: ['model', 'modelAlias', 'publicName', 'upstreamModelId'],
    role: ['role', 'roles'],
    user: ['userEmail', 'userId'],
  };

  return items.filter((item) => {
    if (!item || typeof item !== 'object') return !search;
    const record = item as Record<string, unknown>;
    if (search && !JSON.stringify(record).toLowerCase().includes(search)) return false;
    const created = Date.parse(String(record.createdAt ?? ''));
    if (from !== undefined && (!Number.isFinite(created) || created < from)) return false;
    if (to !== undefined && (!Number.isFinite(created) || created > to)) return false;

    for (const [key, expected] of Object.entries(query)) {
      if (ignored.has(key) || expected === undefined || expected === null || expected === '')
        continue;
      const candidates = aliases[key] ?? [key];
      const actual = candidates
        .map((candidate) => record[candidate])
        .find((value) => value !== undefined);
      const values = Array.isArray(actual) ? actual : [actual];
      if (!values.some((value) => localValueMatches(value, expected))) return false;
    }
    return true;
  });
}

function localValueMatches(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'boolean') return actual === expected;
  const expectedText = String(expected).trim().toLowerCase();
  const actualText = String(actual ?? '').toLowerCase();
  return actualText.includes(expectedText);
}

function parseDate(value: unknown, endOfDay = false): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (!endOfDay || value.includes('T')) return parsed;
  return parsed + 24 * 60 * 60 * 1000 - 1;
}

async function download(path: string, query?: ListQuery): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(withQuery(path, query), {
      credentials: 'include',
      headers: {
        Accept: 'text/csv',
        'X-Requested-With': 'SpiderwebRouterConsole',
      },
    });
  } catch {
    throw new ApiError({ status: 0, code: 'provider_unavailable' });
  }
  if (!response.ok) throw await parseSafeError(response);
  return response.blob();
}

export const apiClient = {
  baseUrl: API_BASE,
  get: <T>(path: string, query?: ListQuery, signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  list,
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body, signal }),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'PATCH', body, signal }),
  delete: <T>(path: string, signal?: AbortSignal) => request<T>(path, { method: 'DELETE', signal }),
  download,
};

export function getSafeError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError({ status: 500, code: 'internal_error' });
}
