export type ModelScanStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface ModelScanJob {
  id: string;
  providerId: string;
  status: ModelScanStatus;
  discoveredCount: number;
  safeErrorCode?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
}

interface PollModelScanOptions {
  jobId: string;
  load: (jobId: string) => Promise<ModelScanJob>;
  wait?: () => Promise<void>;
  maxPolls?: number;
}

export async function pollModelScan({
  jobId,
  load,
  wait = () => new Promise((resolve) => window.setTimeout(resolve, 1_000)),
  maxPolls = 900,
}: PollModelScanOptions): Promise<ModelScanJob> {
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const job = await load(jobId);
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return job;
    await wait();
  }
  throw new Error('model_scan_poll_timeout');
}
