import { Injectable, Optional } from '@nestjs/common';
import { Prisma, type RequestSource } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { AppError } from '../common/errors';
import { appLogger, safeLogObject } from '../common/logger';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { prepareRequestBody } from './request-transform';
import { ProviderAdapterService } from './provider-adapter.service';
import { partialUsageFromError, ResponseNormalizerService } from './response-normalizer.service';
import type { GatewayOperation, ResolvedModel, TokenUsage } from './gateway.types';
import { isRetryableProviderError, ProviderError, retryDelayMs } from './provider-error';
import { SafeFetchService } from './safe-fetch.service';

type JsonObject = Record<string, unknown>;

export interface GatewayHttpResult {
  stream: boolean;
  json?: JsonObject;
  body?: ReadableStream<Uint8Array>;
  contentType: string;
}

const chatSchema = z
  .object({
    model: z.string().min(1).max(255),
    messages: z.array(z.record(z.string(), z.unknown())).min(1),
    stream: z.boolean().optional().default(false),
  })
  .passthrough();

const responsesSchema = z
  .object({
    model: z.string().min(1).max(255),
    input: z.union([z.string(), z.array(z.unknown())]),
    stream: z.boolean().optional().default(false),
    store: z.boolean().optional(),
    background: z.boolean().optional(),
    previous_response_id: z.string().optional(),
    conversation: z.unknown().optional(),
  })
  .passthrough();

const embeddingsSchema = z
  .object({
    model: z.string().min(1).max(255),
    input: z.union([z.string(), z.array(z.unknown())]),
    encoding_format: z.enum(['float', 'base64']).optional(),
    dimensions: z.number().int().positive().max(65536).optional(),
  })
  .passthrough();

@Injectable()
export class GatewayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: ProviderAdapterService,
    private readonly normalizer: ResponseNormalizerService,
    @Optional() private readonly safeFetch?: SafeFetchService,
  ) {}

  async listModels(principal: AuthenticatedPrincipal): Promise<JsonObject> {
    const grants = await this.prisma.userModelGrant.findMany({
      where: {
        userId: principal.userId,
        active: true,
        publishedModel: {
          active: true,
          deletedAt: null,
          provider: { active: true, deletedAt: null },
        },
      },
      include: { publishedModel: true },
      orderBy: { alias: 'asc' },
    });
    return {
      object: 'list',
      data: grants.map((grant) => ({
        id: grant.alias,
        object: 'model',
        created: Math.floor(grant.publishedModel.createdAt.getTime() / 1000),
        owned_by: 'spiderwebrouter',
      })),
    };
  }

  async getModel(principal: AuthenticatedPrincipal, alias: string): Promise<JsonObject> {
    const resolved = await this.resolveModel(principal.userId, alias);
    return {
      id: resolved.alias,
      object: 'model',
      created: Math.floor(resolved.model.createdAt.getTime() / 1000),
      owned_by: 'spiderwebrouter',
    };
  }

  async execute(
    operation: GatewayOperation,
    rawBody: unknown,
    principal: AuthenticatedPrincipal,
    requestId: string,
    signal?: AbortSignal,
    source: RequestSource = 'API',
  ): Promise<GatewayHttpResult> {
    const validated = this.validate(operation, rawBody);
    await this.validateRemoteImageDestinations(validated);
    const alias = validated.model as string;
    const stream = operation !== 'embeddings' && validated.stream === true;
    const resolved = await this.resolveModel(principal.userId, alias);
    this.assertCapability(resolved, operation, validated);
    const requestBody = prepareRequestBody(
      validated,
      operation,
      resolved.model,
      resolved.provider.type,
    );
    const inputPrice = resolved.grant.customInputPricePerM ?? resolved.model.inputPricePerM;
    const outputPrice = resolved.grant.customOutputPricePerM ?? resolved.model.outputPricePerM;
    const startedAt = Date.now();
    const inference = await this.prisma.inferenceRequest.create({
      data: {
        requestId,
        userId: principal.userId,
        apiKeyId: principal.apiKeyId,
        publishedModelId: resolved.model.id,
        endpoint: operation,
        source,
        modelAlias: alias,
        streamed: stream,
        inputPriceSnapshot: inputPrice,
        outputPriceSnapshot: outputPrice,
      },
    });

    const maxAttempts = resolved.model.maxRetries + 1;
    const deadline = startedAt + resolved.provider.timeoutMs;
    let lastError: ProviderError | undefined;
    let attemptsMade = 0;
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      if (signal?.aborted) {
        await this.failRequest(
          inference.id,
          'provider_unavailable',
          Math.max(0, attemptsMade - 1),
          startedAt,
          'CANCELLED',
        );
        throw new AppError('provider_unavailable', 503);
      }
      attemptsMade = attemptNumber;
      const attempt = await this.prisma.providerAttempt.create({
        data: { inferenceRequestId: inference.id, providerId: resolved.provider.id, attemptNumber },
      });
      const attemptStarted = Date.now();
      let effectiveTimeoutMs = resolved.provider.timeoutMs;
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0)
          throw new ProviderError('Overall upstream deadline exceeded', { category: 'timeout' });
        effectiveTimeoutMs = Math.min(resolved.provider.timeoutMs, remainingMs);
        const providerWithRemainingTimeout = {
          ...resolved.provider,
          timeoutMs: effectiveTimeoutMs,
        };
        let adapterResult = await this.adapters.execute(
          providerWithRemainingTimeout,
          resolved.model,
          operation,
          requestBody,
          stream,
          signal,
        );
        if (stream) {
          adapterResult = await this.normalizer.preflight(
            adapterResult,
            operation,
            alias,
            requestId,
            requestBody,
          );
          let finalized = false;
          const finalizeOnce = async (callback: () => Promise<void>) => {
            if (finalized) return;
            finalized = true;
            await callback();
          };
          const body = this.normalizer.stream(
            adapterResult,
            operation,
            alias,
            requestId,
            requestBody,
            async (usage) =>
              finalizeOnce(async () => {
                await this.completeRequest(
                  inference.id,
                  attempt.id,
                  usage,
                  inputPrice,
                  outputPrice,
                  attemptNumber - 1,
                  startedAt,
                  attemptStarted,
                );
                this.logProviderSuccess(
                  resolved,
                  requestId,
                  attemptNumber,
                  Date.now() - attemptStarted,
                  effectiveTimeoutMs,
                  usage,
                );
              }),
            async (error, emittedBytes) =>
              finalizeOnce(async () => {
                const partialUsage = emittedBytes ? partialUsageFromError(error) : undefined;
                this.logProviderFailure(
                  error,
                  resolved,
                  requestId,
                  attemptNumber,
                  false,
                  Date.now() - attemptStarted,
                  effectiveTimeoutMs,
                );
                await this.failStream(
                  inference.id,
                  attempt.id,
                  attemptNumber - 1,
                  startedAt,
                  attemptStarted,
                  partialUsage,
                  inputPrice,
                  outputPrice,
                );
              }),
          );
          return { stream: true, body, contentType: 'text/event-stream; charset=utf-8' };
        }

        const normalized = await this.normalizer.buffered(
          adapterResult,
          operation,
          alias,
          requestId,
          requestBody,
        );
        await this.completeRequest(
          inference.id,
          attempt.id,
          normalized.usage,
          inputPrice,
          outputPrice,
          attemptNumber - 1,
          startedAt,
          attemptStarted,
        );
        this.logProviderSuccess(
          resolved,
          requestId,
          attemptNumber,
          Date.now() - attemptStarted,
          effectiveTimeoutMs,
          normalized.usage,
        );
        return {
          stream: false,
          json: normalized.json,
          contentType: 'application/json; charset=utf-8',
        };
      } catch (unknownError) {
        const error =
          unknownError instanceof ProviderError
            ? unknownError
            : new ProviderError('Unexpected provider adapter failure', {
                category: 'protocol',
                cause: unknownError,
              });
        lastError = error;
        const retryable = isRetryableProviderError(error);
        const canRetry =
          retryable && attemptNumber < maxAttempts && Date.now() < deadline && !signal?.aborted;
        await this.prisma.providerAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'FAILED',
            upstreamStatus: error.status,
            errorCategory: error.category,
            upstreamErrorCode: error.upstreamCode,
            retryable,
            latencyMs: Date.now() - attemptStarted,
            completedAt: new Date(),
          },
        });
        this.logProviderFailure(
          error,
          resolved,
          requestId,
          attemptNumber,
          canRetry,
          Date.now() - attemptStarted,
          effectiveTimeoutMs,
        );
        if (!canRetry) break;
        const delay = Math.min(
          retryDelayMs(attemptNumber, error.retryAfterMs),
          Math.max(0, deadline - Date.now()),
        );
        await abortableDelay(delay, signal);
      }
    }

    const publicError = mapProviderError(lastError);
    await this.failRequest(
      inference.id,
      publicError.code,
      Math.max(0, attemptsMade - 1),
      startedAt,
    );
    throw publicError;
  }

  private validate(operation: GatewayOperation, body: unknown): JsonObject {
    const schema =
      operation === 'chat'
        ? chatSchema
        : operation === 'responses'
          ? responsesSchema
          : embeddingsSchema;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new AppError(
        'invalid_request_error',
        400,
        issue?.message ?? 'The request is invalid.',
        issue?.path.join('.') || null,
      );
    }
    const value = parsed.data as JsonObject;
    if (operation === 'responses') {
      if (value.store === true)
        throw new AppError(
          'unsupported_feature',
          400,
          'Stored responses are not supported.',
          'store',
        );
      if (value.background === true)
        throw new AppError(
          'unsupported_feature',
          400,
          'Background responses are not supported.',
          'background',
        );
      if (value.previous_response_id)
        throw new AppError(
          'unsupported_feature',
          400,
          'Previous response chaining is not supported.',
          'previous_response_id',
        );
      if (value.conversation)
        throw new AppError(
          'unsupported_feature',
          400,
          'Conversations are not supported.',
          'conversation',
        );
    }
    validateImages(value);
    return value;
  }

  private async validateRemoteImageDestinations(body: JsonObject): Promise<void> {
    if (!this.safeFetch) return;
    const urls: string[] = [];
    collectImageUrls(body, urls);
    for (const value of urls) {
      if (value.startsWith('data:')) continue;
      try {
        await this.safeFetch.assertSafeDestination(new URL(value));
      } catch (error) {
        throw new AppError(
          'invalid_request_error',
          400,
          'The remote image URL is not allowed.',
          'input',
          error,
        );
      }
    }
  }

  private async resolveModel(userId: string, alias: string): Promise<ResolvedModel> {
    const grant = await this.prisma.userModelGrant.findUnique({
      where: { userId_alias: { userId, alias } },
      include: { publishedModel: { include: { provider: true } } },
    });
    if (
      !grant?.active ||
      !grant.publishedModel.active ||
      grant.publishedModel.deletedAt ||
      !grant.publishedModel.provider.active ||
      grant.publishedModel.provider.deletedAt
    ) {
      throw new AppError('model_not_found', 404);
    }
    return { grant, model: grant.publishedModel, provider: grant.publishedModel.provider, alias };
  }

  private assertCapability(
    resolved: ResolvedModel,
    operation: GatewayOperation,
    body: JsonObject,
  ): void {
    const capabilities = resolved.model.capabilities as JsonObject;
    const capability = operation === 'chat' ? 'chat' : operation;
    if (capabilities[capability] === false)
      throw new AppError('unsupported_feature', 400, undefined, 'model');
    if (containsImage(body) && capabilities.vision !== true) {
      throw new AppError(
        'unsupported_feature',
        400,
        'This model does not support image input.',
        'input',
      );
    }
    if (body.tools && capabilities.tools === false) {
      throw new AppError('unsupported_feature', 400, 'This model does not support tools.', 'tools');
    }
  }

  private async completeRequest(
    inferenceId: string,
    attemptId: string,
    usage: TokenUsage,
    inputPrice: Prisma.Decimal,
    outputPrice: Prisma.Decimal,
    retryCount: number,
    startedAt: number,
    attemptStarted: number,
  ): Promise<void> {
    const cost = inputPrice
      .mul(usage.inputTokens)
      .add(outputPrice.mul(usage.outputTokens))
      .div(1_000_000);
    await this.prisma.$transaction([
      this.prisma.providerAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'SUCCEEDED',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          retryable: false,
          latencyMs: Date.now() - attemptStarted,
          completedAt: new Date(),
        },
      }),
      this.prisma.inferenceRequest.update({
        where: { id: inferenceId },
        data: {
          status: 'SUCCEEDED',
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
          usageEstimated: usage.estimated,
          costUsd: cost,
          retryCount,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      }),
    ]);
  }

  private async failStream(
    inferenceId: string,
    attemptId: string,
    retryCount: number,
    startedAt: number,
    attemptStarted: number,
    usage: TokenUsage | undefined,
    inputPrice: Prisma.Decimal,
    outputPrice: Prisma.Decimal,
  ): Promise<void> {
    const cost = usage
      ? inputPrice.mul(usage.inputTokens).add(outputPrice.mul(usage.outputTokens)).div(1_000_000)
      : new Prisma.Decimal(0);
    await this.prisma.$transaction([
      this.prisma.providerAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'FAILED',
          errorCategory: 'stream',
          retryable: false,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          latencyMs: Date.now() - attemptStarted,
          completedAt: new Date(),
        },
      }),
      this.prisma.inferenceRequest.update({
        where: { id: inferenceId },
        data: {
          status: 'FAILED',
          safeErrorCode: 'provider_unavailable',
          retryCount,
          inputTokens: usage?.inputTokens ?? 0,
          cachedInputTokens: usage?.cachedInputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          reasoningTokens: usage?.reasoningTokens ?? 0,
          usageEstimated: usage?.estimated ?? false,
          costUsd: cost,
          latencyMs: Date.now() - startedAt,
          completedAt: new Date(),
        },
      }),
    ]);
  }

  private async failRequest(
    inferenceId: string,
    code: string,
    retryCount: number,
    startedAt: number,
    status: 'FAILED' | 'CANCELLED' = 'FAILED',
  ): Promise<void> {
    await this.prisma.inferenceRequest.update({
      where: { id: inferenceId },
      data: {
        status,
        safeErrorCode: code,
        retryCount,
        latencyMs: Date.now() - startedAt,
        completedAt: new Date(),
      },
    });
  }

  private logProviderFailure(
    error: unknown,
    resolved: ResolvedModel,
    requestId: string,
    attemptNumber: number,
    willRetry: boolean,
    latencyMs: number,
    timeoutMs: number,
  ): void {
    const providerError = error instanceof ProviderError ? error : undefined;
    const fields = {
      request_id: requestId,
      provider_id: resolved.provider.id,
      provider_name: resolved.provider.name,
      upstream_model: resolved.model.upstreamModelId,
      destination: providerError?.destination,
      attempt_number: attemptNumber,
      upstream_status: providerError?.status,
      upstream_error_type: providerError?.category,
      upstream_error_code: providerError?.upstreamCode,
      upstream_error_body: providerError?.rawBody,
      retry: willRetry,
      latency_ms: latencyMs,
      timeout_ms: timeoutMs,
      details: safeLogObject(providerError?.cause),
      err: providerError?.cause instanceof Error ? providerError.cause : error,
    };
    if (willRetry) appLogger.warn(fields, 'provider_attempt_failed_retrying');
    else appLogger.error(fields, 'provider_attempt_failed');
  }

  private logProviderSuccess(
    resolved: ResolvedModel,
    requestId: string,
    attemptNumber: number,
    latencyMs: number,
    timeoutMs: number,
    usage: TokenUsage,
  ): void {
    appLogger.info(
      {
        request_id: requestId,
        provider_id: resolved.provider.id,
        provider_name: resolved.provider.name,
        upstream_model: resolved.model.upstreamModelId,
        attempt_number: attemptNumber,
        latency_ms: latencyMs,
        timeout_ms: timeoutMs,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        usage_estimated: usage.estimated,
      },
      'provider_attempt_succeeded',
    );
  }
}

function mapProviderError(error?: ProviderError): AppError {
  if (error?.status === 429) return new AppError('rate_limit_error', 429, undefined, null, error);
  if (error?.category === 'timeout')
    return new AppError('upstream_timeout', 504, undefined, null, error);
  return new AppError('provider_unavailable', 503, undefined, null, error);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(new AppError('provider_unavailable', 503));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  if (!value || typeof value !== 'object') return false;
  const object = value as JsonObject;
  if (object.type === 'image_url' || object.type === 'input_image') return true;
  return Object.values(object).some(containsImage);
}

function validateImages(value: unknown): void {
  const urls: string[] = [];
  collectImageUrls(value, urls);
  if (urls.length > 5)
    throw new AppError(
      'invalid_request_error',
      400,
      'A request can contain at most 5 images.',
      'input',
    );
  for (const url of urls) {
    if (url.startsWith('data:')) {
      const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(url);
      if (!match?.[1])
        throw new AppError('invalid_request_error', 400, 'The image data URL is invalid.', 'input');
      if (Math.floor(match[1].length * 0.75) > 10 * 1024 * 1024) {
        throw new AppError(
          'invalid_request_error',
          413,
          'Each image must be at most 10 MiB.',
          'input',
        );
      }
    } else {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new AppError('invalid_request_error', 400, 'The image URL is invalid.', 'input');
      }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new AppError(
          'invalid_request_error',
          400,
          'Remote images must use a public HTTPS URL.',
          'input',
        );
      }
    }
  }
}

function collectImageUrls(value: unknown, result: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectImageUrls(item, result);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const object = value as JsonObject;
  if (object.type === 'image_url' && object.image_url && typeof object.image_url === 'object') {
    const url = (object.image_url as JsonObject).url;
    if (typeof url === 'string') result.push(url);
  }
  if (object.type === 'input_image' && typeof object.image_url === 'string')
    result.push(object.image_url);
  for (const child of Object.values(object)) collectImageUrls(child, result);
}
