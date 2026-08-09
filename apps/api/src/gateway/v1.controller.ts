import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { once } from 'node:events';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentPrincipal } from '../auth/auth.decorators';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { GatewayService } from './gateway.service';

@Controller('v1')
@UseGuards(ApiKeyGuard)
@ApiTags('OpenAI-compatible API')
@ApiBearerAuth('apiKey')
export class V1Controller {
  constructor(private readonly gateway: GatewayService) {}

  @Get('models')
  @ApiOperation({ summary: 'List models available to the current API key' })
  @ApiResponse({ status: 200, schema: modelListSchema() })
  @ApiResponse({ status: 401, schema: safeErrorSchema() })
  listModels(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.gateway.listModels(principal);
  }

  @Get('models/:id')
  @ApiOperation({ summary: 'Retrieve an available model by its public alias' })
  @ApiParam({ name: 'id', description: 'User-visible model alias', example: 'assistant-fast' })
  @ApiResponse({ status: 200, schema: modelSchema() })
  @ApiResponse({ status: 404, schema: safeErrorSchema() })
  getModel(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.gateway.getModel(principal, id);
  }

  @Post('chat/completions')
  @ApiOperation({ summary: 'Create an OpenAI-compatible chat completion' })
  @ApiBody({
    schema: chatRequestSchema(),
    examples: {
      basic: { value: { model: 'assistant-fast', messages: [{ role: 'user', content: 'Hello' }] } },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Chat completion JSON or data-only SSE when stream=true.',
    content: gatewaySuccessContent(),
  })
  @ApiResponse({ status: 400, schema: safeErrorSchema() })
  @ApiResponse({ status: 401, schema: safeErrorSchema() })
  @ApiResponse({ status: 503, schema: safeErrorSchema() })
  chat(
    @Body() body: unknown,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.handle('chat', body, principal, request, reply);
  }

  @Post('responses')
  @ApiOperation({ summary: 'Create an OpenAI Responses API response' })
  @ApiBody({
    schema: responsesRequestSchema(),
    examples: { basic: { value: { model: 'assistant-fast', input: 'Hello', store: false } } },
  })
  @ApiResponse({
    status: 200,
    description: 'Response JSON or typed Responses SSE when stream=true.',
    content: gatewaySuccessContent(),
  })
  @ApiResponse({ status: 400, schema: safeErrorSchema() })
  @ApiResponse({ status: 401, schema: safeErrorSchema() })
  @ApiResponse({ status: 503, schema: safeErrorSchema() })
  responses(
    @Body() body: unknown,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.handle('responses', body, principal, request, reply);
  }

  @Post('embeddings')
  @ApiOperation({ summary: 'Create OpenAI-compatible embeddings' })
  @ApiBody({
    schema: embeddingsRequestSchema(),
    examples: {
      basic: { value: { model: 'embedding-default', input: ['First text', 'Second text'] } },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Embedding list.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['object', 'model', 'data'],
          properties: {
            object: { type: 'string', example: 'list' },
            model: { type: 'string' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  object: { type: 'string' },
                  index: { type: 'integer' },
                  embedding: { type: 'array', items: { type: 'number' } },
                },
              },
            },
            usage: { type: 'object' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, schema: safeErrorSchema() })
  @ApiResponse({ status: 401, schema: safeErrorSchema() })
  @ApiResponse({ status: 503, schema: safeErrorSchema() })
  embeddings(
    @Body() body: unknown,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.handle('embeddings', body, principal, request, reply);
  }

  private async handle(
    operation: 'chat' | 'responses' | 'embeddings',
    body: unknown,
    principal: AuthenticatedPrincipal,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
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
      );
      reply.header('x-request-id', request.id);
      reply.header('cache-control', 'no-store');
      if (!result.stream || !result.body) return result.json;
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': result.contentType,
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
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

function safeErrorSchema(): SchemaObject {
  return {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['message', 'type', 'code', 'request_id'],
        properties: {
          message: { type: 'string', example: 'The model service is temporarily unavailable.' },
          type: { type: 'string', example: 'server_error' },
          param: { type: 'string', nullable: true },
          code: { type: 'string', example: 'provider_unavailable' },
          request_id: { type: 'string', example: '7dc7169c-689c-4ec3-a452-a74da64c6d43' },
        },
      },
    },
  };
}

function modelSchema(): SchemaObject {
  return {
    type: 'object',
    required: ['id', 'object', 'created', 'owned_by'],
    properties: {
      id: { type: 'string', example: 'assistant-fast' },
      object: { type: 'string', example: 'model' },
      created: { type: 'integer', example: 1786200000 },
      owned_by: { type: 'string', example: 'spiderwebrouter' },
    },
  };
}

function modelListSchema(): SchemaObject {
  return {
    type: 'object',
    required: ['object', 'data'],
    properties: {
      object: { type: 'string', example: 'list' },
      data: { type: 'array', items: modelSchema() },
    },
  };
}

function chatRequestSchema(): SchemaObject {
  return {
    type: 'object',
    required: ['model', 'messages'],
    additionalProperties: true,
    properties: {
      model: { type: 'string', description: 'User-visible model alias.' },
      messages: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['role', 'content'],
          additionalProperties: true,
          properties: {
            role: { type: 'string', enum: ['system', 'developer', 'user', 'assistant', 'tool'] },
            content: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
          },
        },
      },
      tools: { type: 'array', items: { type: 'object' } },
      response_format: { type: 'object' },
      stream: { type: 'boolean', default: false },
    },
  };
}

function responsesRequestSchema(): SchemaObject {
  return {
    type: 'object',
    required: ['model', 'input'],
    additionalProperties: true,
    properties: {
      model: { type: 'string', description: 'User-visible model alias.' },
      input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
      instructions: { type: 'string' },
      tools: { type: 'array', items: { type: 'object' } },
      text: { type: 'object', description: 'Responses text/structured-output configuration.' },
      max_output_tokens: { type: 'integer', minimum: 1 },
      stream: { type: 'boolean', default: false },
      store: { type: 'boolean', enum: [false], default: false },
    },
  };
}

function embeddingsRequestSchema(): SchemaObject {
  return {
    type: 'object',
    required: ['model', 'input'],
    additionalProperties: true,
    properties: {
      model: { type: 'string', description: 'User-visible embedding model alias.' },
      input: {
        oneOf: [
          { type: 'string' },
          {
            type: 'array',
            items: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'integer' } }] },
          },
        ],
      },
      encoding_format: { type: 'string', enum: ['float', 'base64'] },
      dimensions: { type: 'integer', minimum: 1 },
    },
  };
}

function gatewaySuccessContent(): Record<string, { schema: SchemaObject }> {
  return {
    'application/json': { schema: { type: 'object', additionalProperties: true } },
    'text/event-stream': {
      schema: {
        type: 'string',
        example: 'event: response.completed\ndata: {"type":"response.completed",...}\n\n',
      },
    },
  };
}

export function safeStreamFailure(
  operation: 'chat' | 'responses' | 'embeddings',
  requestId: string,
): string {
  if (operation === 'responses') {
    const now = Math.floor(Date.now() / 1000);
    const response = {
      type: 'response.failed',
      sequence_number: 0,
      response: {
        id: `resp_${requestId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`,
        object: 'response',
        created_at: now,
        completed_at: now,
        status: 'failed',
        model: 'unknown',
        error: { code: 'server_error', message: 'The model service is temporarily unavailable.' },
        incomplete_details: null,
        instructions: null,
        output: [],
        output_text: '',
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: { effort: null, summary: null },
        store: false,
        temperature: 1,
        text: { format: { type: 'text' } },
        tool_choice: 'auto',
        tools: [],
        top_p: 1,
        truncation: 'disabled',
        usage: null,
      },
    };
    return `event: response.failed\ndata: ${JSON.stringify(response)}\n\n`;
  }
  const envelope = {
    error: {
      message: 'The model service is temporarily unavailable.',
      type: 'server_error',
      param: null,
      code: 'provider_unavailable',
      request_id: requestId,
    },
  };
  return `data: ${JSON.stringify(envelope)}\n\ndata: [DONE]\n\n`;
}
