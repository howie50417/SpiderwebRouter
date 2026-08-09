import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { KeycloakJwtGuard } from '../auth/keycloak-jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentPrincipal, Roles } from '../auth/auth.decorators';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { AdminService } from './admin.service';
import type { UsageHttpQuery } from '../usage/usage-query.service';

@Controller('api/admin')
@UseGuards(KeycloakJwtGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@ApiTags('Administration')
@ApiBearerAuth('keycloak')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('dashboard')
  dashboard() {
    return this.admin.dashboard();
  }

  @Get('providers')
  listProviders() {
    return this.admin.listProviders();
  }

  @Post('providers')
  createProvider(
    @Body() body: unknown,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.createProvider(body, actor, req.id);
  }

  @Patch('providers/:id')
  updateProvider(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.updateProvider(id, body, actor, req.id);
  }

  @Delete('providers/:id')
  deleteProvider(
    @Param('id') id: string,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.deleteProvider(id, actor, req.id);
  }

  @Post('providers/:id/test')
  testProvider(
    @Param('id') id: string,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.testProvider(id, actor, req.id);
  }

  @Post('providers/:id/scan')
  scanProvider(
    @Param('id') id: string,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.scanProvider(id, actor, req.id);
  }

  @Post('model-scans')
  scanProviderAlias(
    @Body() body: { providerId?: string },
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.scanProvider(body.providerId ?? '', actor, req.id);
  }

  @Get('discovered-models')
  discovered(@Query('providerId') providerId?: string) {
    return this.admin.listDiscovered(providerId);
  }

  @Get('models')
  listModels() {
    return this.admin.listModels();
  }

  @Get('published-models')
  listPublishedModels() {
    return this.admin.listModels();
  }

  @Post('models')
  createModel(
    @Body() body: unknown,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.createModel(body, actor, req.id);
  }

  @Post('published-models')
  createPublishedModel(
    @Body() body: unknown,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.createModel(body, actor, req.id);
  }

  @Patch('models/:id')
  updateModel(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.updateModel(id, body, actor, req.id);
  }

  @Patch('published-models/:id')
  updatePublishedModel(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.updateModel(id, body, actor, req.id);
  }

  @Delete('models/:id')
  deleteModel(
    @Param('id') id: string,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.deleteModel(id, actor, req.id);
  }

  @Delete('published-models/:id')
  deletePublishedModel(
    @Param('id') id: string,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.deleteModel(id, actor, req.id);
  }

  @Get('users')
  users() {
    return this.admin.listUsers();
  }

  @Post('users')
  createUser(
    @Body() body: unknown,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.createUser(body, actor, req.id);
  }

  @Patch('users/:id')
  updateUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.updateUser(id, body, actor, req.id);
  }

  @Get('grants')
  grants(@Query('userId') userId?: string) {
    return this.admin.listGrants(userId);
  }

  @Get('users/:id/grants')
  userGrants(@Param('id') id: string) {
    return this.admin.listGrants(id);
  }

  @Post('grants')
  upsertGrant(
    @Body() body: unknown,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.upsertGrant(body, actor, req.id);
  }

  @Post('users/:id/grants')
  upsertUserGrant(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    const publishedModelId = body.publishedModelId ?? body.modelId;
    return this.admin.upsertGrant({ ...body, userId: id, publishedModelId }, actor, req.id);
  }

  @Delete('grants/:id')
  deleteGrant(
    @Param('id') id: string,
    @CurrentPrincipal() actor: AuthenticatedPrincipal,
    @Req() req: FastifyRequest,
  ) {
    return this.admin.deleteGrant(id, actor, req.id);
  }

  @Get('attempts')
  attempts(@Query('limit', new ParseIntPipe({ optional: true })) limit?: number) {
    return this.admin.listAttempts(limit);
  }

  @Get('usage')
  usage(@Query() query: UsageHttpQuery) {
    return this.admin.usage(query);
  }

  @Get('usage.csv')
  async usageCsv(@Query() query: UsageHttpQuery, @Res({ passthrough: true }) reply: FastifyReply) {
    const csv = await this.admin.usageCsv(query);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="spiderwebrouter-admin-usage.csv"');
    return csv;
  }

  @Get('audit')
  audit(@Query('limit', new ParseIntPipe({ optional: true })) limit?: number) {
    return this.admin.listAudit(limit);
  }
}
