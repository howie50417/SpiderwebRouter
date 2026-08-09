import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { JobsModule } from '../jobs/jobs.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [GatewayModule, JobsModule, UsageModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
