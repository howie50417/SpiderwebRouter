import type { ProviderConnection, PublishedModel, UserModelGrant } from '@prisma/client';

export type GatewayOperation = 'chat' | 'responses' | 'embeddings';

export interface ResolvedModel {
  grant: UserModelGrant;
  model: PublishedModel;
  provider: ProviderConnection;
  alias: string;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimated: boolean;
}

export interface AdapterResult {
  response: Response;
  wireFormat:
    | 'openai-chat'
    | 'openai-responses'
    | 'openai-embeddings'
    | 'ollama-chat'
    | 'gemini-chat'
    | 'gemini-embeddings';
  requestedStream: boolean;
}

export interface ScannedModel {
  upstreamModelId: string;
  displayName?: string;
  capabilities: Record<string, boolean | string>;
  metadata?: Record<string, unknown>;
}

export interface PreparedGatewayRequest {
  operation: GatewayOperation;
  body: Record<string, unknown>;
  stream: boolean;
}
