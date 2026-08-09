import { Module } from '@nestjs/common';
import { UsageQueryService } from './usage-query.service';

@Module({ providers: [UsageQueryService], exports: [UsageQueryService] })
export class UsageModule {}
