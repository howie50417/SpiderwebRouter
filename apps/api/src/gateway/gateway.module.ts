import { Module } from '@nestjs/common';
import { GatewayService } from './gateway.service';
import { ProviderAdapterService } from './provider-adapter.service';
import { ResponseNormalizerService } from './response-normalizer.service';
import { SafeFetchService } from './safe-fetch.service';
import { V1Controller } from './v1.controller';

@Module({
  controllers: [V1Controller],
  providers: [GatewayService, ProviderAdapterService, ResponseNormalizerService, SafeFetchService],
  exports: [GatewayService, ProviderAdapterService, SafeFetchService],
})
export class GatewayModule {}
