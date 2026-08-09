import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { loadRuntimeConfig } from '../config/runtime-config';

export const MODEL_SCAN_QUEUE = 'model-scans';

@Injectable()
export class ScanQueueService implements OnModuleDestroy {
  private readonly config = loadRuntimeConfig();
  private readonly connection = new Redis(this.config.redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  private readonly queue = new Queue(MODEL_SCAN_QUEUE, { connection: this.connection });

  async enqueue(scanJobId: string, requestId: string): Promise<void> {
    await this.queue.add(
      'scan-provider',
      { scanJobId, requestId },
      {
        jobId: scanJobId,
        attempts: 1,
        removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
