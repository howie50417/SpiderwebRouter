import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { ModelScanService } from './model-scan.service';
import { ScanQueueService } from './scan-queue.service';

@Module({
  imports: [GatewayModule],
  providers: [ModelScanService, ScanQueueService],
  exports: [ModelScanService, ScanQueueService],
})
export class JobsModule {}
