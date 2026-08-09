import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { KeycloakJwtGuard } from '../auth/keycloak-jwt.guard';
import { OpenApiService } from './openapi.service';

@Controller('api')
@UseGuards(KeycloakJwtGuard)
@ApiTags('Documentation')
@ApiBearerAuth('keycloak')
export class OpenApiController {
  constructor(private readonly openApi: OpenApiService) {}

  @Get('openapi.json')
  @ApiExcludeEndpoint()
  document() {
    return this.openApi.getDocument();
  }
}
