import { describe, expect, it, vi } from 'vitest';
import { ModelScanService } from '../src/jobs/model-scan.service';

describe('model scan deletion guard', () => {
  it('does not call an upstream provider for a queued job after deletion', async () => {
    const scanJobUpdate = vi.fn().mockResolvedValue({});
    const prisma = {
      scanJob: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'scan-job-id',
          providerId: 'provider-id',
          provider: {
            id: 'provider-id',
            active: false,
            deletedAt: new Date(),
          },
        }),
        update: scanJobUpdate,
      },
    };
    const adapters = { scan: vi.fn() };
    const service = new ModelScanService(prisma as never, adapters as never);

    await expect(service.run('scan-job-id', 'request-id')).rejects.toThrow(
      'The provider became unavailable before its scan started',
    );
    expect(adapters.scan).not.toHaveBeenCalled();
    expect(scanJobUpdate).toHaveBeenCalledWith({
      where: { id: 'scan-job-id' },
      data: expect.objectContaining({
        status: 'FAILED',
        safeErrorCode: 'invalid_request_error',
        finishedAt: expect.any(Date),
      }),
    });
  });
});
