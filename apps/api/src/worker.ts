import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AppModule } from './app.module';
import { PrismaService } from './database/prisma.service';
import { ProviderAdapterService } from './gateway/provider-adapter.service';
import { loadRuntimeConfig } from './config/runtime-config';
import { appLogger } from './common/logger';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { MODEL_SCAN_QUEUE } from './jobs/scan-queue.service';
import { ModelScanService } from './jobs/model-scan.service';

async function startWorker(): Promise<void> {
  loadRuntimeConfig({ refresh: true });
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const adapters = app.get(ProviderAdapterService);
  const modelScan = app.get(ModelScanService);
  const config = loadRuntimeConfig();
  const scanConnection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const scanWorker = new Worker(
    MODEL_SCAN_QUEUE,
    async (job) => {
      const scanJobId = job.data?.scanJobId;
      const requestId = job.data?.requestId;
      if (typeof scanJobId !== 'string') throw new Error('Invalid model scan job payload');
      await modelScan.run(scanJobId, typeof requestId === 'string' ? requestId : undefined);
    },
    { connection: scanConnection, concurrency: 2 },
  );
  scanWorker.on('failed', (job, error) => {
    appLogger.error(
      { queue_job_id: job?.id, scan_job_id: job?.data?.scanJobId, err: error },
      'model_scan_job_failed',
    );
  });
  let stopping = false;
  let rollupRunning = false;
  let healthRunning = false;

  const rollup = async () => {
    if (stopping || rollupRunning) return;
    rollupRunning = true;
    try {
      await rebuildRecentRollups(prisma);
    } catch (error) {
      appLogger.error({ err: error }, 'usage_rollup_failed');
    } finally {
      rollupRunning = false;
    }
  };
  const health = async () => {
    if (stopping || healthRunning) return;
    healthRunning = true;
    try {
      const providers = await prisma.providerConnection.findMany({ where: { active: true } });
      for (const provider of providers) {
        try {
          await adapters.scan(provider);
          await prisma.providerConnection.update({
            where: { id: provider.id },
            data: { healthStatus: 'HEALTHY', lastHealthCheckAt: new Date() },
          });
        } catch (error) {
          appLogger.error(
            { provider_id: provider.id, provider_name: provider.name, err: error },
            'provider_health_check_failed',
          );
          await prisma.providerConnection.update({
            where: { id: provider.id },
            data: { healthStatus: 'UNHEALTHY', lastHealthCheckAt: new Date() },
          });
        }
      }
    } finally {
      healthRunning = false;
    }
  };

  await rollup();
  await health();
  const rollupTimer = setInterval(() => void rollup(), 5 * 60_000);
  const healthTimer = setInterval(() => void health(), 15 * 60_000);
  appLogger.info('worker_started');

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(rollupTimer);
    clearInterval(healthTimer);
    await scanWorker.close();
    scanConnection.disconnect();
    await app.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

async function rebuildRecentRollups(prisma: PrismaService): Promise<void> {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 1);
  from.setUTCHours(0, 0, 0, 0);
  const requests = await prisma.inferenceRequest.findMany({
    where: { createdAt: { gte: from }, status: { in: ['SUCCEEDED', 'FAILED'] } },
    select: {
      createdAt: true,
      userId: true,
      apiKeyId: true,
      publishedModelId: true,
      status: true,
      retryCount: true,
      inputTokens: true,
      outputTokens: true,
      costUsd: true,
    },
  });
  const groups = new Map<
    string,
    {
      usageDate: Date;
      userId: string;
      apiKeyId: string | null;
      publishedModelId: string;
      requestCount: number;
      errorCount: number;
      retryCount: number;
      inputTokens: bigint;
      outputTokens: bigint;
      costUsd: Prisma.Decimal;
    }
  >();
  for (const request of requests) {
    const usageDate = new Date(request.createdAt);
    usageDate.setUTCHours(0, 0, 0, 0);
    const key = `${usageDate.toISOString()}|${request.userId}|${request.apiKeyId ?? '-'}|${request.publishedModelId}`;
    const group = groups.get(key) ?? {
      usageDate,
      userId: request.userId,
      apiKeyId: request.apiKeyId,
      publishedModelId: request.publishedModelId,
      requestCount: 0,
      errorCount: 0,
      retryCount: 0,
      inputTokens: 0n,
      outputTokens: 0n,
      costUsd: new Prisma.Decimal(0),
    };
    group.requestCount += 1;
    if (request.status === 'FAILED') group.errorCount += 1;
    group.retryCount += request.retryCount;
    group.inputTokens += BigInt(request.inputTokens);
    group.outputTokens += BigInt(request.outputTokens);
    group.costUsd = group.costUsd.add(request.costUsd);
    groups.set(key, group);
  }
  await prisma.$transaction(async (tx) => {
    await tx.usageDailyRollup.deleteMany({ where: { usageDate: { gte: from } } });
    if (groups.size) await tx.usageDailyRollup.createMany({ data: [...groups.values()] });
  });
  appLogger.info({ rollup_rows: groups.size }, 'usage_rollup_completed');
}

startWorker().catch((error: unknown) => {
  appLogger.fatal({ err: error }, 'worker_start_failed');
  process.exitCode = 1;
});
