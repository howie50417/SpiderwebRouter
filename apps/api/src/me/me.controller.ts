import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { RequestSource } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { once } from 'node:events';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { KeycloakJwtGuard } from '../auth/keycloak-jwt.guard';
import { CurrentPrincipal } from '../auth/auth.decorators';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { GatewayService } from '../gateway/gateway.service';
import type { GatewayOperation } from '../gateway/gateway.types';
import { safeStreamFailure } from '../gateway/v1.controller';
import { MeService } from './me.service';
import type { UsageHttpQuery } from '../usage/usage-query.service';

@Controller('api/me')
@UseGuards(KeycloakJwtGuard)
@ApiTags('Customer console')
@ApiBearerAuth('keycloak')
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly gateway: GatewayService,
  ) {}

  @Get()
  profile(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.me.profile(principal);
  }

  @Get('models')
  models(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.me.models(principal);
  }

  @Get('api-keys')
  apiKeys(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.me.listApiKeys(principal);
  }

  @Post('api-keys')
  createApiKey(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.me.createApiKey(principal, body, request.id);
  }

  @Delete('api-keys/:id')
  revokeApiKey(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ) {
    return this.me.revokeApiKey(principal, id, request.id);
  }

  @Get('usage')
  usage(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Query() query: UsageHttpQuery) {
    return this.me.usage(principal, query);
  }

  @Get('dashboard')
  dashboard(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.me.dashboard(principal);
  }

  @Get('usage.csv')
  async usageCsv(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query() query: UsageHttpQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const csv = await this.me.usageCsv(principal, query);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="spiderwebrouter-usage.csv"');
    return csv;
  }

  @Post('playground/:operation')
  playground(
    @Param('operation') operation: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.gatewayRequest(operation, body, principal, request, reply, 'PLAYGROUND');
  }

  @Post('docs-test/:operation')
  docsTest(
    @Param('operation') operation: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.gatewayRequest(operation, body, principal, request, reply, 'DOCS');
  }

  @Get('docs-test/v1/models')
  @ApiExcludeEndpoint()
  docsModels(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.gateway.listModels(principal);
  }

  @Get('docs-test/models')
  @ApiExcludeEndpoint()
  docsModelsAlias(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.gateway.listModels(principal);
  }

  @Get('docs-test/v1/models/:id')
  @ApiExcludeEndpoint()
  docsModel(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.gateway.getModel(principal, id);
  }

  @Get('docs-test/models/:id')
  @ApiExcludeEndpoint()
  docsModelAlias(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.gateway.getModel(principal, id);
  }

  @Post('docs-test/v1/chat/completions')
  @ApiExcludeEndpoint()
  docsChat(
    @Body() body: unknown,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.gatewayRequest('chat', body, principal, request, reply, 'DOCS');
  }

  @Post('docs-test/v1/responses')
  @ApiExcludeEndpoint()
  docsResponses(
    @Body() body: unknown,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.gatewayRequest('responses', body, principal, request, reply, 'DOCS');
  }

  @Post('docs-test/v1/embeddings')
  @ApiExcludeEndpoint()
  docsEmbeddings(
    @Body() body: unknown,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.gatewayRequest('embeddings', body, principal, request, reply, 'DOCS');
  }

  private async gatewayRequest(
    operationValue: string,
    body: unknown,
    principal: AuthenticatedPrincipal,
    request: FastifyRequest,
    reply: FastifyReply,
    source: RequestSource,
  ): Promise<unknown> {
    const operation = parseOperation(operationValue);
    const abort = new AbortController();
    const onDisconnect = () => {
      if (!reply.raw.writableFinished) abort.abort(new Error('client disconnected'));
    };
    request.raw.once('aborted', onDisconnect);
    reply.raw.once('close', onDisconnect);
    if (request.raw.aborted) onDisconnect();
    try {
      const result = await this.gateway.execute(
        operation,
        body,
        principal,
        request.id,
        abort.signal,
        source,
      );
      reply.header('x-request-id', request.id);
      reply.header('cache-control', 'no-store');
      if (!result.stream || !result.body) return result.json;
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': result.contentType,
        'cache-control': 'no-cache, no-store',
        'x-accel-buffering': 'no',
        'x-request-id': request.id,
      });
      const reader = result.body.getReader();
      let emittedBodyBytes = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength) emittedBodyBytes = true;
          if (!reply.raw.write(Buffer.from(value))) await once(reply.raw, 'drain');
        }
      } catch {
        if (!reply.raw.writableEnded && (operation !== 'responses' || !emittedBodyBytes)) {
          reply.raw.write(safeStreamFailure(operation, request.id));
        }
      } finally {
        if (!reply.raw.writableEnded) reply.raw.end();
      }
      return undefined;
    } finally {
      request.raw.off('aborted', onDisconnect);
      reply.raw.off('close', onDisconnect);
    }
  }
}

function parseOperation(value: string): GatewayOperation {
  if (value === 'chat' || value === 'responses' || value === 'embeddings') return value;
  throw new AppError('invalid_request_error', 404, 'The gateway operation was not found.');
}
