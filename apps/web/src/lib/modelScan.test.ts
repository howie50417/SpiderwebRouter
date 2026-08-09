import { describe, expect, it, vi } from 'vitest';

import { pollModelScan, type ModelScanJob } from '@/lib/modelScan';

function job(status: ModelScanJob['status']): ModelScanJob {
  return {
    id: 'scan-1',
    providerId: 'provider-1',
    status,
    discoveredCount: status === 'SUCCEEDED' ? 3 : 0,
    createdAt: '2026-08-09T00:00:00.000Z',
  };
}

describe('pollModelScan', () => {
  it('waits until a scan reaches a successful terminal state', async () => {
    const load = vi
      .fn<() => Promise<ModelScanJob>>()
      .mockResolvedValueOnce(job('PENDING'))
      .mockResolvedValueOnce(job('RUNNING'))
      .mockResolvedValueOnce(job('SUCCEEDED'));
    const wait = vi.fn(async () => undefined);

    await expect(pollModelScan({ jobId: 'scan-1', load, wait })).resolves.toMatchObject({
      status: 'SUCCEEDED',
      discoveredCount: 3,
    });
    expect(load).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('returns a failed job without retrying forever', async () => {
    await expect(
      pollModelScan({
        jobId: 'scan-1',
        load: async () => ({ ...job('FAILED'), safeErrorCode: 'provider_unavailable' }),
        wait: async () => undefined,
      }),
    ).resolves.toMatchObject({ status: 'FAILED', safeErrorCode: 'provider_unavailable' });
  });
});
