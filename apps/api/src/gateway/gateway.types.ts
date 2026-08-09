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

export const MODEL_CAPABILITY_KEYS = [
  'chat',
  'responses',
  'embeddings',
  'vision',
  'tools',
  'structuredOutput',
  'streaming',
  'reasoning',
] as const;

export type ModelCapabilityKey = (typeof MODEL_CAPABILITY_KEYS)[number];
export type ScannedCapabilityState = boolean | 'unconfirmed';
export type ScannedModelCapabilities = Record<ModelCapabilityKey, ScannedCapabilityState> & {
  /** Internal execution hint. `responses` describes the Router-facing capability. */
  nativeResponses: boolean;
};

export interface ScannedModel {
  upstreamModelId: string;
  displayName?: string;
  capabilities: ScannedModelCapabilities;
  metadata?: Record<string, unknown>;
}

export interface PreparedGatewayRequest {
  operation: GatewayOperation;
  body: Record<string, unknown>;
  stream: boolean;
}
