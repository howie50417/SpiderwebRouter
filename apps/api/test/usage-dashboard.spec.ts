import { describe, expect, it, vi } from 'vitest';
import { UsageQueryService } from '../src/usage/usage-query.service';

const userId = '849a4f99-61c7-401c-9565-2b8c0aaa372c';

function sqlValues(value: unknown): unknown[] {
  return (value as { values?: unknown[] }).values ?? [];
}

describe('usage dashboard and filtering', () => {
  it('builds a complete 30-day personal dashboard and scopes every query to the user', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
    try {
      const queryRaw = vi
        .fn()
        .mockResolvedValueOnce([
          {
            requests: 2n,
            failedRequests: 1n,
            retries: 3n,
            inputTokens: 10n,
            outputTokens: 20n,
            amountUsd: '0.42',
            averageLatencyMs: 150n,
          },
        ])
        .mockResolvedValueOnce([
          { date: '2026-08-09', requests: 2n, tokens: 30n, amountUsd: '0.42', failures: 1n },
        ])
        .mockResolvedValueOnce([
          { name: 'private-model', requests: 2n, tokens: 30n, amountUsd: '0.42' },
        ]);
      const service = new UsageQueryService({ $queryRaw: queryRaw } as never);

      const result = await service.dashboard(userId);

      expect(queryRaw).toHaveBeenCalledTimes(3);
      for (const [query] of queryRaw.mock.calls) {
        expect(sqlValues(query)).toContain(userId);
      }
      expect(result.summary).toEqual({
        requests: 2,
        failedRequests: 1,
        retries: 3,
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        amountUsd: '0.42',
        averageLatencyMs: 150,
      });
      expect(result.series).toHaveLength(30);
      expect(result.series[0]).toEqual({
        date: '2026-07-11',
        requests: 0,
        tokens: 0,
        amountUsd: 0,
        failures: 0,
      });
      expect(result.series.at(-1)).toEqual({
        date: '2026-08-09',
        requests: 2,
        tokens: 30,
        amountUsd: 0.42,
        failures: 1,
      });
      expect(result.topModels).toEqual([
        { name: 'private-model', requests: 2, tokens: 30, amountUsd: '0.42' },
      ]);
      expect(result.topUsers).toEqual([]);
      expect(result.topApiKeys).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one filter set for rows, count, summary and series', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const queryRaw = vi.fn().mockResolvedValue([]);
    const service = new UsageQueryService({
      inferenceRequest: { findMany, count },
      $queryRaw: queryRaw,
    } as never);

    const result = await service.query(
      {
        page: '2',
        pageSize: '25',
        from: '2026-08-01',
        to: '2026-08-09',
        model: 'private-model',
        apiKey: 'console',
        kind: 'RESPONSES',
        source: 'PLAYGROUND',
        status: 'FAILED',
      },
      userId,
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 25, take: 25, where: expect.any(Object) }),
    );
    const detailWhere = findMany.mock.calls[0]?.[0]?.where;
    expect(count).toHaveBeenCalledWith({ where: detailWhere });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    for (const [query] of queryRaw.mock.calls) {
      const values = sqlValues(query);
      expect(values).toEqual(
        expect.arrayContaining([userId, '%private-model%', 'responses', 'PLAYGROUND', 'FAILED']),
      );
    }
    expect(result).toMatchObject({
      data: [],
      total: 0,
      page: 2,
      pageSize: 25,
      summary: {
        requests: 0,
        failedRequests: 0,
        totalTokens: 0,
        amountUsd: '0',
      },
      series: [],
    });
  });
});
