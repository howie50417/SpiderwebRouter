import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import {
  buildUsageQuery,
  createDefaultUsageDateRange,
  LatestUsageRequest,
  withoutUsagePagination,
} from '@/lib/usageQuery';

describe('usage page queries', () => {
  it('defaults and falls back after form reset to the latest 30 calendar days', () => {
    const range = createDefaultUsageDateRange(dayjs('2026-08-09T12:00:00'));

    expect(buildUsageQuery({}, range)).toMatchObject({
      from: '2026-07-11',
      to: '2026-08-09',
    });
    expect(buildUsageQuery({ createdAt: undefined }, range)).toMatchObject({
      from: '2026-07-11',
      to: '2026-08-09',
    });
  });

  it('sends every table filter to the shared detail, summary and series request', () => {
    const fallback = createDefaultUsageDateRange(dayjs('2026-08-09'));
    const query = buildUsageQuery(
      {
        current: 3,
        pageSize: 50,
        createdAt: [dayjs('2026-07-01'), dayjs('2026-07-31')],
        userEmail: 'user@example.com',
        model: 'model-a',
        apiKeyName: 'production',
        kind: 'RESPONSES',
        source: 'API',
        status: 'SUCCEEDED',
      },
      fallback,
    );

    expect(query).toEqual({
      page: 3,
      pageSize: 50,
      user: 'user@example.com',
      model: 'model-a',
      apiKey: 'production',
      kind: 'RESPONSES',
      source: 'API',
      status: 'SUCCEEDED',
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(withoutUsagePagination(query)).toEqual({
      user: 'user@example.com',
      model: 'model-a',
      apiKey: 'production',
      kind: 'RESPONSES',
      source: 'API',
      status: 'SUCCEEDED',
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('recognizes only the newest response during fast filter changes', () => {
    const sequence = new LatestUsageRequest();
    const slowRequest = sequence.begin();
    const latestRequest = sequence.begin();

    expect(sequence.isLatest(slowRequest)).toBe(false);
    expect(sequence.isLatest(latestRequest)).toBe(true);
  });
});
