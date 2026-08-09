import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ProviderAdapterService } from '../gateway/provider-adapter.service';
import { appLogger } from '../common/logger';
import { ProviderError } from '../gateway/provider-error';

@Injectable()
export class ModelScanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: ProviderAdapterService,
  ) {}

  async run(scanJobId: string, requestId?: string): Promise<number> {
    const job = await this.prisma.scanJob.findUnique({
      where: { id: scanJobId },
      include: { provider: true },
    });
    if (!job) throw new Error('Scan job not found');
    const startedAt = Date.now();
    await this.prisma.scanJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING', startedAt: new Date(), safeErrorCode: null },
    });
    try {
      const models = await this.adapters.scan(job.provider);
      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.discoveredModel.updateMany({
          where: { providerId: job.providerId },
          data: { available: false },
        });
        for (const model of models) {
          await tx.discoveredModel.upsert({
            where: {
              providerId_upstreamModelId: {
                providerId: job.providerId,
                upstreamModelId: model.upstreamModelId,
              },
            },
            create: {
              providerId: job.providerId,
              upstreamModelId: model.upstreamModelId,
              displayName: model.displayName,
              capabilities: model.capabilities as Prisma.InputJsonValue,
              metadata: (model.metadata ?? {}) as Prisma.InputJsonValue,
              available: true,
              lastSeenAt: now,
            },
            update: {
              displayName: model.displayName,
              capabilities: model.capabilities as Prisma.InputJsonValue,
              metadata: (model.metadata ?? {}) as Prisma.InputJsonValue,
              available: true,
              lastSeenAt: now,
            },
          });
        }
        await tx.scanJob.update({
          where: { id: job.id },
          data: { status: 'SUCCEEDED', discoveredCount: models.length, finishedAt: now },
        });
        await tx.providerConnection.update({
          where: { id: job.providerId },
          data: { healthStatus: 'HEALTHY', lastHealthCheckAt: now },
        });
      });
      appLogger.info(
        {
          request_id: requestId,
          scan_job_id: job.id,
          provider_id: job.providerId,
          provider_name: job.provider.name,
          discovered_count: models.length,
          latency_ms: Date.now() - startedAt,
        },
        'provider_scan_succeeded',
      );
      return models.length;
    } catch (error) {
      await this.prisma.$transaction([
        this.prisma.scanJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', safeErrorCode: 'provider_unavailable', finishedAt: new Date() },
        }),
        this.prisma.providerConnection.update({
          where: { id: job.providerId },
          data: { healthStatus: 'UNHEALTHY', lastHealthCheckAt: new Date() },
        }),
      ]);
      const providerError = error instanceof ProviderError ? error : undefined;
      appLogger.error(
        {
          request_id: requestId,
          scan_job_id: job.id,
          provider_id: job.providerId,
          provider_name: job.provider.name,
          destination: providerError?.destination,
          upstream_status: providerError?.status,
          upstream_error_type: providerError?.category,
          upstream_error_code: providerError?.upstreamCode,
          upstream_error_body: providerError?.rawBody,
          latency_ms: Date.now() - startedAt,
          timeout_ms: job.provider.timeoutMs,
          err: error,
        },
        'provider_scan_failed',
      );
      throw error;
    }
  }
}
