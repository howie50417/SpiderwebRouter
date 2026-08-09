import { Injectable } from '@nestjs/common';
import type { ProviderConnection, PublishedModel } from '@prisma/client';
import { CryptoService } from '../security/crypto.service';
import { SafeFetchService } from './safe-fetch.service';
import type { AdapterResult, GatewayOperation, ScannedModel } from './gateway.types';
import { chatToGemini, embeddingToGemini, responsesToChat } from './request-transform';
import { ProviderError } from './provider-error';
import {
  detectModelCapabilities,
  type ModelCapabilityDetection,
} from './model-capability-detection';

type JsonObject = Record<string, unknown>;

@Injectable()
export class ProviderAdapterService {
  constructor(
    private readonly safeFetch: SafeFetchService,
    private readonly crypto: CryptoService,
  ) {}

  async scan(provider: ProviderConnection, signal?: AbortSignal): Promise<ScannedModel[]> {
    const secret = this.crypto.decryptSecret(provider.encryptedSecret);
    const { url, headers } = this.scanRequest(provider, secret);
    const response = await this.safeFetch.fetch(
      url,
      { method: 'GET', headers, signal },
      provider.timeoutMs,
    );
    const data = await this.readJson(response);
    if (provider.type === 'OLLAMA') {
      const models = Array.isArray(data.models) ? (data.models as JsonObject[]) : [];
      return models.map((item) => ({
        upstreamModelId: String(item.name ?? item.model),
        displayName: String(item.name ?? item.model),
        capabilities: {
          chat: true,
          responses: true,
          embeddings: true,
          vision: 'unconfirmed',
          tools: 'unconfirmed',
          structuredOutput: 'unconfirmed',
          streaming: 'unconfirmed',
          reasoning: 'unconfirmed',
          nativeResponses: false,
        },
        metadata: {
          ...pickMetadata(item, ['size', 'modified_at', 'details']),
          capabilityEvidence: {
            responses: [
              {
                source: 'router_emulation',
                path: 'router.responses_via_chat',
                state: true,
                emulated: true,
                via: 'chat',
              },
            ],
          },
        },
      }));
    }
    if (provider.type === 'GEMINI') {
      const models = Array.isArray(data.models) ? (data.models as JsonObject[]) : [];
      return models
        .map((item) => {
          const detection = detectModelCapabilities(item, { emulateResponsesFromChat: true });
          return {
            upstreamModelId: String(item.name ?? '').replace(/^models\//, ''),
            displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
            capabilities: detection.capabilities,
            metadata: detectionMetadata(
              pickMetadata(item, ['description', 'inputTokenLimit', 'outputTokenLimit']),
              detection,
            ),
          };
        })
        .filter((item) => item.upstreamModelId);
    }
    const models = Array.isArray(data.data)
      ? (data.data as JsonObject[])
      : Array.isArray(data.models)
        ? (data.models as JsonObject[])
        : [];
    const runtimeStatus = isUnslothStyleCatalog(models)
      ? await this.tryReadUnslothStatus(provider, headers, signal)
      : undefined;
    return models
      .map((item) => {
        const matchedStatus =
          runtimeStatus && matchesActiveModel(item, runtimeStatus)
            ? prepareUnslothStatus(runtimeStatus)
            : undefined;
        const detection = detectModelCapabilities(
          matchedStatus ? { ...item, runtimeStatus: matchedStatus } : item,
          {
            emulateResponsesFromChat: provider.type !== 'OPENAI',
          },
        );
        return {
          upstreamModelId: String(item.id ?? item.name ?? item.model),
          displayName: typeof item.name === 'string' ? item.name : undefined,
          capabilities: detection.capabilities,
          metadata: detectionMetadata(
            pickMetadata(item, [
              'created',
              'owned_by',
              'object',
              'loaded',
              'quant',
              'max_context_length',
              'native_context_length',
            ]),
            detection,
          ),
        };
      })
      .filter((item) => item.upstreamModelId);
  }

  async execute(
    provider: ProviderConnection,
    model: PublishedModel,
    operation: GatewayOperation,
    body: JsonObject,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<AdapterResult> {
    const secret = this.crypto.decryptSecret(provider.encryptedSecret);
    if (provider.type === 'GEMINI')
      return this.executeGemini(provider, model, operation, body, stream, secret, signal);
    if (provider.type === 'OLLAMA')
      return this.executeOllama(provider, model, operation, body, stream, secret, signal);

    let effectiveOperation = operation;
    let requestBody = body;
    const capabilities = asObject(model.capabilities);
    if (operation === 'responses' && provider.type === 'OPEN_WEBUI') {
      effectiveOperation = 'chat';
      requestBody = responsesToChat(body);
    } else if (
      operation === 'responses' &&
      provider.type === 'GENERIC_OPENAI' &&
      capabilities.nativeResponses !== true
    ) {
      effectiveOperation = 'chat';
      requestBody = responsesToChat(body);
    }
    const url = this.openAiUrl(provider, effectiveOperation);
    const headers = this.headers(provider, secret);
    const forceBuffered = operation === 'responses' && effectiveOperation === 'chat';
    const outboundBody =
      effectiveOperation === 'embeddings'
        ? requestBody
        : { ...requestBody, stream: forceBuffered ? false : stream };
    const response = await this.safeFetch.fetch(
      url,
      { method: 'POST', headers, body: JSON.stringify(outboundBody), signal },
      provider.timeoutMs,
    );
    return {
      response,
      wireFormat:
        effectiveOperation === 'chat'
          ? 'openai-chat'
          : effectiveOperation === 'responses'
            ? 'openai-responses'
            : 'openai-embeddings',
      requestedStream: stream,
    };
  }

  private async executeGemini(
    provider: ProviderConnection,
    model: PublishedModel,
    operation: GatewayOperation,
    body: JsonObject,
    stream: boolean,
    secret?: string,
    signal?: AbortSignal,
  ): Promise<AdapterResult> {
    const headers = this.headers(provider, secret);
    const base = trimApiVersion(provider.baseUrl);
    if (operation === 'embeddings') {
      const url = new URL(
        `${base}/v1beta/models/${encodeURIComponent(model.upstreamModelId)}:batchEmbedContents`,
      );
      const response = await this.safeFetch.fetch(
        url,
        { method: 'POST', headers, body: JSON.stringify(embeddingToGemini(body)), signal },
        provider.timeoutMs,
      );
      return { response, wireFormat: 'gemini-embeddings', requestedStream: false };
    }
    const chatBody = operation === 'responses' ? responsesToChat(body) : body;
    const method =
      stream && operation === 'chat' ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = new URL(
      `${base}/v1beta/models/${encodeURIComponent(model.upstreamModelId)}:${method}`,
    );
    const response = await this.safeFetch.fetch(
      url,
      { method: 'POST', headers, body: JSON.stringify(chatToGemini(chatBody)), signal },
      provider.timeoutMs,
    );
    return { response, wireFormat: 'gemini-chat', requestedStream: stream };
  }

  private async executeOllama(
    provider: ProviderConnection,
    _model: PublishedModel,
    operation: GatewayOperation,
    body: JsonObject,
    stream: boolean,
    secret?: string,
    signal?: AbortSignal,
  ): Promise<AdapterResult> {
    const headers = this.headers(provider, secret);
    const base = trimKnownSuffix(provider.baseUrl, '/api');
    if (operation === 'embeddings') {
      const response = await this.safeFetch.fetch(
        new URL(`${base}/api/embed`),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: body.model,
            input: body.input,
            dimensions: body.dimensions,
          }),
          signal,
        },
        provider.timeoutMs,
      );
      return { response, wireFormat: 'openai-embeddings', requestedStream: false };
    }
    const chatBody = operation === 'responses' ? responsesToChat(body) : body;
    const forceBuffered = operation === 'responses';
    const response = await this.safeFetch.fetch(
      new URL(`${base}/api/chat`),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...chatBody, stream: forceBuffered ? false : stream }),
        signal,
      },
      provider.timeoutMs,
    );
    return { response, wireFormat: 'ollama-chat', requestedStream: stream };
  }

  private scanRequest(
    provider: ProviderConnection,
    secret?: string,
  ): { url: URL; headers: Headers } {
    const headers = this.headers(provider, secret);
    if (provider.type === 'OLLAMA')
      return { url: new URL(`${trimKnownSuffix(provider.baseUrl, '/api')}/api/tags`), headers };
    if (provider.type === 'OPEN_WEBUI')
      return { url: new URL(`${trimKnownSuffix(provider.baseUrl, '/api')}/api/models`), headers };
    if (provider.type === 'GEMINI')
      return {
        url: new URL(`${trimApiVersion(provider.baseUrl)}/v1beta/models?pageSize=1000`),
        headers,
      };
    return { url: new URL(`${trimKnownSuffix(provider.baseUrl, '/v1')}/v1/models`), headers };
  }

  private openAiUrl(provider: ProviderConnection, operation: GatewayOperation): URL {
    const base =
      provider.type === 'OPEN_WEBUI'
        ? `${trimKnownSuffix(provider.baseUrl, '/api')}/api`
        : `${trimKnownSuffix(provider.baseUrl, '/v1')}/v1`;
    const path = operation === 'chat' ? 'chat/completions' : operation;
    return new URL(`${base}/${path}`);
  }

  private async tryReadUnslothStatus(
    provider: ProviderConnection,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<JsonObject | undefined> {
    try {
      const base = trimKnownSuffix(provider.baseUrl, '/v1');
      const response = await this.safeFetch.fetch(
        new URL(`${base}/v1/status`),
        { method: 'GET', headers, signal },
        Math.min(provider.timeoutMs, 5_000),
      );
      return await this.readJson(response);
    } catch (error) {
      // `/v1/status` is an optional, read-only Unsloth enrichment endpoint. A
      // missing/older endpoint must not turn a successful catalog scan into a
      // failed scan, while an explicit job cancellation must still propagate.
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  private headers(provider: ProviderConnection, secret?: string): Headers {
    const headers = new Headers({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });
    if (!secret || provider.authMode === 'NONE') return headers;
    if (provider.type === 'GEMINI' || provider.authMode === 'API_KEY')
      headers.set('x-goog-api-key', secret);
    else headers.set('authorization', `Bearer ${secret}`);
    return headers;
  }

  private async readJson(response: Response): Promise<JsonObject> {
    try {
      return (await response.json()) as JsonObject;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('Upstream returned malformed JSON', {
        category: 'protocol',
        cause: error,
      });
    }
  }
}

function trimKnownSuffix(value: string, suffix: string): string {
  const base = value.replace(/\/$/, '');
  return base.toLowerCase().endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}

function trimApiVersion(value: string): string {
  return value.replace(/\/$/, '').replace(/\/v1(?:beta)?$/i, '');
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function pickMetadata(value: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );
}

function detectionMetadata(metadata: JsonObject, detection: ModelCapabilityDetection): JsonObject {
  return {
    ...metadata,
    ...(Object.keys(detection.evidence).length ? { capabilityEvidence: detection.evidence } : {}),
    ...(detection.supportedThinkingLevels
      ? { supportedThinkingLevels: detection.supportedThinkingLevels }
      : {}),
  };
}

function isUnslothStyleCatalog(models: JsonObject[]): boolean {
  return models.some((item) => {
    if (String(item.owned_by ?? '').toLowerCase() === 'unsloth-studio') return true;
    if (typeof item.loaded !== 'boolean') return false;
    return [
      'quant',
      'context_length',
      'max_context_length',
      'native_context_length',
      'display_name',
    ].some((key) => item[key] !== undefined);
  });
}

function matchesActiveModel(item: JsonObject, status: JsonObject | undefined): boolean {
  if (!status) return false;
  const modelId = item.id ?? item.name ?? item.model;
  if (typeof modelId !== 'string' || !modelId.trim()) return false;
  const catalogIds = [modelId];
  if (typeof item.quant === 'string' && item.quant.trim()) {
    catalogIds.push(`${modelId}:${item.quant}`);
  }
  const statusIds = [
    status.active_model,
    status.model_identifier,
    status.model_id,
    status.model,
    status.id,
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  return catalogIds.some((catalogId) =>
    statusIds.some((statusId) => catalogId.trim().toLowerCase() === statusId.trim().toLowerCase()),
  );
}

function prepareUnslothStatus(status: JsonObject): JsonObject {
  const levels = Array.isArray(status.reasoning_effort_levels)
    ? status.reasoning_effort_levels.filter((value): value is string => typeof value === 'string')
    : [];
  if (status.supports_reasoning === true && status.reasoning_always_on !== true) {
    levels.unshift('off');
  }
  const existingCapabilities = asObject(status.capabilities);
  const capabilities: JsonObject = { ...existingCapabilities };
  if (status.is_diffusion !== true && status.is_audio !== true) {
    capabilities.chat = true;
    capabilities.responses = true;
    capabilities.streaming = true;
  }
  if (typeof status.is_vision === 'boolean') capabilities.vision = status.is_vision;
  if (typeof status.supports_tools === 'boolean') capabilities.tools = status.supports_tools;
  if (typeof status.supports_reasoning === 'boolean') {
    capabilities.reasoning = status.supports_reasoning;
  }
  return {
    ...status,
    capabilities,
    ...(levels.length ? { supportedThinkingLevels: [...new Set(levels)] } : {}),
  };
}
