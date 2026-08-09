import { Global, Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { KeycloakJwtGuard } from './keycloak-jwt.guard';
import { RolesGuard } from './roles.guard';
import { SessionService } from './session.service';
import { AuthController } from './auth.controller';
import { KeycloakAdminService } from './keycloak-admin.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [ApiKeyGuard, KeycloakJwtGuard, RolesGuard, SessionService, KeycloakAdminService],
  exports: [ApiKeyGuard, KeycloakJwtGuard, RolesGuard, SessionService, KeycloakAdminService],
})
export class AuthModule {}
