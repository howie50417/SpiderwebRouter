import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [GatewayModule, UsageModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
