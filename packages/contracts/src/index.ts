export const providerTypes = [
  'OPENAI',
  'GEMINI',
  'OPENAI_COMPATIBLE',
  'OLLAMA',
  'OPEN_WEBUI',
] as const;

export type ProviderType = (typeof providerTypes)[number];

export const providerAuthModes = ['NONE', 'BEARER', 'API_KEY'] as const;
export type ProviderAuthMode = (typeof providerAuthModes)[number];

export const promptModes = ['NONE', 'PREPEND', 'REPLACE'] as const;
export type PromptMode = (typeof promptModes)[number];

export const thinkingLevels = [
  'PROVIDER_DEFAULT',
  'OFF',
  'MINIMAL',
  'LOW',
  'MEDIUM',
  'HIGH',
  'XHIGH',
  'MAX',
] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export const inferenceKinds = ['CHAT', 'RESPONSES', 'EMBEDDINGS'] as const;
export type InferenceKind = (typeof inferenceKinds)[number];

export const requestSources = ['API', 'PLAYGROUND', 'DOCS'] as const;
export type RequestSource = (typeof requestSources)[number];

export const requestStatuses = ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type RequestStatus = (typeof requestStatuses)[number];

export const publicErrorCodes = [
  'invalid_request_error',
  'authentication_error',
  'permission_denied',
  'model_not_found',
  'unsupported_feature',
  'rate_limit_error',
  'provider_unavailable',
  'upstream_timeout',
  'internal_error',
] as const;
export type PublicErrorCode = (typeof publicErrorCodes)[number];

export interface ModelCapabilities {
  chat: boolean;
  responses: boolean;
  embeddings: boolean;
  vision: boolean;
  tools: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  reasoning: boolean;
}

export interface SafeApiError {
  message: string;
  type: PublicErrorCode;
  param: string | null;
  code: PublicErrorCode;
  request_id: string;
}

export interface OpenAIErrorEnvelope {
  error: SafeApiError;
}

export interface ControlPlaneErrorEnvelope {
  code: PublicErrorCode;
  message: string;
  requestId: string;
  fieldErrors?: Record<string, string[]>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  estimated: boolean;
}

export interface UsageAmount extends TokenUsage {
  amountUsd: string;
  inputPriceUsdPerMillion: string;
  outputPriceUsdPerMillion: string;
}

export interface ApiList<T> {
  data: T[];
  total: number;
}

export interface DashboardSummary {
  requests: number;
  failedRequests: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  amountUsd: string;
  averageLatencyMs: number;
}
