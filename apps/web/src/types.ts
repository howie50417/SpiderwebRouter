import type {
  DashboardSummary,
  ModelCapabilities,
  ProviderAuthMode,
  ProviderType,
  PromptMode,
  ThinkingLevel,
  UsageAmount,
} from '@spiderwebrouter/contracts';

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'USER';

export interface Identity {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  locale?: 'zh-TW' | 'en-US';
}

export interface ProviderRecord {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  authMode: ProviderAuthMode;
  enabled: boolean;
  healthStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  timeoutMs: number;
  secretConfigured: boolean;
  discoveredModelCount?: number;
  lastCheckedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DiscoveredCapabilityState = boolean | 'unconfirmed';

export type DiscoveredModelCapabilities = Partial<
  Record<keyof ModelCapabilities, DiscoveredCapabilityState>
> & {
  /** Internal routing hint. It is not shown as a customer-facing capability. */
  nativeResponses?: boolean;
};

export interface DiscoveredModelMetadata extends Record<string, unknown> {
  supportedThinkingLevels?: ThinkingLevel[];
}

export type CapabilitySource =
  | 'METADATA'
  | 'PROVIDER_STATUS'
  | 'ROUTER_EMULATION'
  | 'OFFICIAL_CATALOG'
  | 'MIXED'
  | 'ADMIN_CONFIRMED'
  | 'UNKNOWN';

export type ThinkingControlMode = 'FIXED' | 'USER_SELECTABLE';

export interface DiscoveredModel {
  id: string;
  providerId: string;
  providerName: string;
  upstreamModelId: string;
  capabilities: DiscoveredModelCapabilities;
  metadata: DiscoveredModelMetadata;
  capabilitySource: CapabilitySource;
  firstSeenAt: string;
  lastSeenAt: string;
  published: boolean;
}

export interface PublishedModelCapabilities extends ModelCapabilities {
  /** Internal routing hint retained while administrators edit the model. */
  nativeResponses?: boolean;
}

export interface PublishedModel {
  id: string;
  providerId: string;
  providerName: string;
  upstreamModelId: string;
  publicName: string;
  enabled: boolean;
  capabilities: PublishedModelCapabilities;
  promptMode: PromptMode;
  systemPrompt?: string | null;
  thinkingLevel: ThinkingLevel;
  thinkingControlMode: ThinkingControlMode;
  supportedThinkingLevels: ThinkingLevel[];
  maxRetries: number;
  inputPriceUsdPerMillion: string;
  outputPriceUsdPerMillion: string;
  grantCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  enabled: boolean;
  modelGrantCount: number;
  createdAt: string;
  lastLoginAt?: string | null;
}

export interface UserModelGrant {
  id: string;
  userId: string;
  publishedModelId: string;
  modelName: string;
  alias: string;
  enabled: boolean;
  customInputPriceUsdPerMillion: string | null;
  customOutputPriceUsdPerMillion: string | null;
  createdAt: string;
}

export interface UsageRecord extends UsageAmount {
  id: string;
  createdAt: string;
  userId: string;
  userEmail?: string;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  model: string;
  kind: 'CHAT' | 'RESPONSES' | 'EMBEDDINGS';
  source: 'API' | 'PLAYGROUND' | 'DOCS';
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  retries: number;
  latencyMs: number;
  requestId: string;
}

export interface UsageSeriesPoint {
  date: string;
  requests: number;
  tokens: number;
  amountUsd: number;
  failures?: number;
}

export interface RankedUsage {
  name: string;
  requests: number;
  tokens: number;
  amountUsd: string;
}

export interface DashboardData {
  summary: DashboardSummary;
  series: UsageSeriesPoint[];
  topModels: RankedUsage[];
  topUsers: RankedUsage[];
  topApiKeys?: RankedUsage[];
}

export interface UsageResponse {
  data: UsageRecord[];
  total: number;
  summary?: Partial<DashboardSummary>;
  series?: UsageSeriesPoint[];
}

export interface AuditRecord {
  id: string;
  createdAt: string;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  changes?: Record<string, unknown> | null;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  lastFour: string;
  enabled: boolean;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKeyRecord {
  key: string;
}

export interface ModelOption {
  id: string;
  name: string;
  capabilities: Partial<ModelCapabilities>;
  thinkingControlMode: ThinkingControlMode;
  supportedThinkingLevels: ThinkingLevel[];
  parameterSupport: {
    temperature: boolean | 'unconfirmed';
  };
}

export interface PageResult<T> {
  data: T[];
  total: number;
}

export interface ListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  [key: string]: string | number | boolean | undefined | null;
}
