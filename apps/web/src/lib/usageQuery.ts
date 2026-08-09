import dayjs, { type Dayjs } from 'dayjs';

import type { ListQuery } from '@/types';

export interface UsageTableParams {
  current?: number;
  pageSize?: number;
  createdAt?: unknown;
  userEmail?: unknown;
  model?: unknown;
  apiKeyName?: unknown;
  kind?: unknown;
  source?: unknown;
  status?: unknown;
}

export function createDefaultUsageDateRange(now: Dayjs = dayjs()): [Dayjs, Dayjs] {
  return [now.subtract(29, 'day').startOf('day'), now.endOf('day')];
}

export function buildUsageQuery(
  params: UsageTableParams,
  defaultDateRange: readonly [Dayjs, Dayjs],
): ListQuery {
  const selectedRange = Array.isArray(params.createdAt) ? params.createdAt : defaultDateRange;
  return {
    page: params.current,
    pageSize: params.pageSize,
    user: stringValue(params.userEmail),
    model: stringValue(params.model),
    apiKey: stringValue(params.apiKeyName),
    kind: stringValue(params.kind),
    source: stringValue(params.source),
    status: stringValue(params.status),
    from: dateValue(selectedRange[0]),
    to: dateValue(selectedRange[1]),
  };
}

export function withoutUsagePagination(query: ListQuery): ListQuery {
  const { page: _page, pageSize: _pageSize, ...filters } = query;
  return filters;
}

export class LatestUsageRequest {
  private sequence = 0;

  begin(): number {
    this.sequence += 1;
    return this.sequence;
  }

  isLatest(request: number): boolean {
    return request === this.sequence;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function dateValue(value: unknown): string | undefined {
  if (dayjs.isDayjs(value)) return value.format('YYYY-MM-DD');
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return dayjs(value).format('YYYY-MM-DD');
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : undefined;
}
