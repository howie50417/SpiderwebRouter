import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { SecurityModule } from './security/security.module';
import { AuthModule } from './auth/auth.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthController } from './health/health.controller';
import { AdminModule } from './admin/admin.module';
import { MeModule } from './me/me.module';
import { DocsModule } from './docs/docs.module';

@Module({
  imports: [
    DatabaseModule,
    SecurityModule,
    AuthModule,
    GatewayModule,
    AdminModule,
    MeModule,
    DocsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
