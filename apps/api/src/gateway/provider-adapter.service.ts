import { Injectable } from '@nestjs/common';
import type { ProviderConnection, PublishedModel } from '@prisma/client';
import { CryptoService } from '../security/crypto.service';
import { SafeFetchService } from './safe-fetch.service';
import type { AdapterResult, GatewayOperation, ScannedModel } from './gateway.types';
import { chatToGemini, embeddingToGemini, responsesToChat } from './request-transform';
import { ProviderError } from './provider-error';

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
        },
        metadata: pickMetadata(item, ['size', 'modified_at', 'details']),
      }));
    }
    if (provider.type === 'GEMINI') {
      const models = Array.isArray(data.models) ? (data.models as JsonObject[]) : [];
      return models
        .map((item) => ({
          upstreamModelId: String(item.name ?? '').replace(/^models\//, ''),
          displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
          capabilities: geminiCapabilities(item.supportedGenerationMethods),
          metadata: pickMetadata(item, ['description', 'inputTokenLimit', 'outputTokenLimit']),
        }))
        .filter((item) => item.upstreamModelId);
    }
    const models = Array.isArray(data.data)
      ? (data.data as JsonObject[])
      : Array.isArray(data.models)
        ? (data.models as JsonObject[])
        : [];
    return models
      .map((item) => ({
        upstreamModelId: String(item.id ?? item.name ?? item.model),
        displayName: typeof item.name === 'string' ? item.name : undefined,
        capabilities: {
          chat: true,
          streaming: 'unconfirmed',
          responses: 'unconfirmed',
          embeddings: 'unconfirmed',
          vision: 'unconfirmed',
          tools: 'unconfirmed',
        },
        metadata: pickMetadata(item, ['created', 'owned_by', 'object']),
      }))
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
      capabilities.responses !== true
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

function geminiCapabilities(methods: unknown): Record<string, boolean> {
  const list = Array.isArray(methods) ? methods.map(String) : [];
  return {
    chat: list.includes('generateContent'),
    streaming: list.includes('streamGenerateContent') || list.includes('generateContent'),
    embeddings: list.includes('embedContent') || list.includes('batchEmbedContents'),
    responses: true,
  };
}
