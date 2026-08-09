import { thinkingLevels, type ThinkingLevel } from '@spiderwebrouter/contracts';

const capabilityKeys = [
  'chat',
  'responses',
  'embeddings',
  'vision',
  'tools',
  'structuredOutput',
  'streaming',
  'reasoning',
] as const;

type UnknownRecord = Record<string, unknown>;

interface UsageAccumulator {
  requests: number;
  failedRequests: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  amountUsd: number;
  latency: number;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeCapabilities(value: unknown): UnknownRecord {
  const source = record(value);
  return {
    ...Object.fromEntries(capabilityKeys.map((key) => [key, source[key] === true])),
    ...(source.nativeResponses === true ? { nativeResponses: true } : {}),
  };
}

function normalizeDiscoveredCapabilities(value: unknown): UnknownRecord {
  const source = record(value);
  return {
    ...Object.fromEntries(
      capabilityKeys.map((key) => {
        const raw = source[key];
        if (raw === true || String(raw).toUpperCase() === 'SUPPORTED') return [key, true];
        if (raw === false || String(raw).toUpperCase() === 'UNSUPPORTED') return [key, false];
        return [key, 'unconfirmed'];
      }),
    ),
    ...(source.nativeResponses === true ? { nativeResponses: true } : {}),
  };
}

function normalizeDiscoveredMetadata(value: unknown): UnknownRecord {
  const source = record(value);
  const validThinkingLevels = new Set<string>(thinkingLevels);
  const supportedThinkingLevels = Array.isArray(source.supportedThinkingLevels)
    ? source.supportedThinkingLevels.filter(
        (level): level is ThinkingLevel =>
          typeof level === 'string' && validThinkingLevels.has(level),
      )
    : [];
  return {
    ...source,
    ...(supportedThinkingLevels.length ? { supportedThinkingLevels } : {}),
  };
}

function inferCapabilitySource(value: unknown, metadata: UnknownRecord): string {
  if (typeof value === 'string' && value) return value;
  const evidence: UnknownRecord[] = [];
  collectEvidence(metadata.capabilityEvidence, evidence);
  const hasStatus = evidence.some((item) =>
    `${stringValue(item.source)} ${stringValue(item.path)}`.toLowerCase().includes('status'),
  );
  const hasMetadata = evidence.some((item) => {
    const source = stringValue(item.source).toLowerCase();
    const path = stringValue(item.path).toLowerCase();
    return (
      !path.includes('status') &&
      (source.includes('upstream_metadata') || source.includes('provider_metadata'))
    );
  });
  const hasRouter = evidence.some((item) =>
    stringValue(item.source).toLowerCase().includes('router_emulation'),
  );
  const sources = [hasMetadata, hasStatus, hasRouter].filter(Boolean).length;
  if (sources > 1) return 'MIXED';
  if (hasStatus) return 'PROVIDER_STATUS';
  if (hasMetadata) return 'METADATA';
  if (hasRouter) return 'ROUTER_EMULATION';
  return 'UNKNOWN';
}

function collectEvidence(value: unknown, result: UnknownRecord[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectEvidence(entry, result));
    return;
  }
  const source = record(value);
  if (!Object.keys(source).length) return;
  if (source.source !== undefined || source.path !== undefined) result.push(source);
  else Object.values(source).forEach((entry) => collectEvidence(entry, result));
}

function mapCollection(payload: unknown, mapper: (value: unknown) => unknown): unknown {
  if (Array.isArray(payload)) return payload.map(mapper);
  if (!payload || typeof payload !== 'object') return payload;
  const source = payload as UnknownRecord;
  if (Array.isArray(source.data)) {
    return { ...source, data: source.data.map(mapper) };
  }
  if (Array.isArray(source.items)) {
    return { ...source, items: source.items.map(mapper) };
  }
  return mapper(payload);
}

function normalizeIdentity(value: unknown): unknown {
  const source = record(value);
  const role = stringValue(source.role, 'USER');
  return {
    ...source,
    displayName: stringValue(source.displayName, stringValue(source.email)),
    roles: Array.isArray(source.roles) ? source.roles : [role],
    enabled: source.enabled ?? source.active ?? true,
  };
}

function normalizeProvider(value: unknown): unknown {
  const source = record(value);
  const count = record(source._count);
  return {
    ...source,
    type: source.type === 'GENERIC_OPENAI' ? 'OPENAI_COMPATIBLE' : source.type,
    enabled: source.enabled ?? source.active ?? false,
    secretConfigured: source.secretConfigured ?? source.hasSecret ?? false,
    discoveredModelCount: source.discoveredModelCount ?? count.discoveredModels ?? 0,
    lastCheckedAt: source.lastCheckedAt ?? source.lastHealthCheckAt ?? null,
  };
}

function normalizePublishedModel(value: unknown): unknown {
  const source = record(value);
  const provider = record(source.provider);
  const count = record(source._count);
  return {
    ...source,
    providerName: source.providerName ?? provider.name ?? '—',
    publicName: source.publicName ?? source.defaultAlias ?? '',
    enabled: source.enabled ?? source.active ?? false,
    capabilities: normalizeCapabilities(source.capabilities),
    inputPriceUsdPerMillion: stringValue(
      source.inputPriceUsdPerMillion ?? source.inputPricePerM,
      '0',
    ),
    outputPriceUsdPerMillion: stringValue(
      source.outputPriceUsdPerMillion ?? source.outputPricePerM,
      '0',
    ),
    grantCount: source.grantCount ?? count.grants ?? 0,
  };
}

function normalizeDiscoveredModel(value: unknown): unknown {
  const source = record(value);
  const provider = record(source.provider);
  const metadata = normalizeDiscoveredMetadata(source.metadata);
  return {
    ...source,
    providerId: source.providerId ?? provider.id,
    providerName: source.providerName ?? provider.name ?? '—',
    capabilities: normalizeDiscoveredCapabilities(source.capabilities),
    metadata,
    capabilitySource: inferCapabilitySource(source.capabilitySource, metadata),
    firstSeenAt: source.firstSeenAt ?? source.createdAt,
    published: source.published ?? false,
  };
}

function normalizeUser(value: unknown): unknown {
  const source = record(value);
  const count = record(source._count);
  const role = stringValue(source.role, 'USER');
  return {
    ...source,
    displayName: stringValue(source.displayName, stringValue(source.email)),
    roles: Array.isArray(source.roles) ? source.roles : [role],
    enabled: source.enabled ?? source.active ?? false,
    modelGrantCount: source.modelGrantCount ?? count.grants ?? 0,
  };
}

function normalizeGrant(value: unknown): unknown {
  const source = record(value);
  const model = record(source.publishedModel);
  return {
    ...source,
    modelName: source.modelName ?? model.displayName ?? model.defaultAlias ?? source.alias,
    enabled: source.enabled ?? source.active ?? false,
    customInputPriceUsdPerMillion:
      source.customInputPriceUsdPerMillion ?? source.customInputPricePerM ?? null,
    customOutputPriceUsdPerMillion:
      source.customOutputPriceUsdPerMillion ?? source.customOutputPricePerM ?? null,
  };
}

function normalizeApiKey(value: unknown): unknown {
  const source = record(value);
  return {
    ...source,
    enabled: source.enabled ?? source.active ?? false,
  };
}

function normalizeModelOption(value: unknown): unknown {
  const source = record(value);
  return {
    ...source,
    name: source.name ?? source.alias ?? source.displayName ?? '',
    capabilities: normalizeCapabilities(source.capabilities),
  };
}

function normalizeUsageRow(value: unknown): UnknownRecord {
  const source = record(value);
  const apiKey = record(source.apiKey);
  const inputTokens = numberValue(source.inputTokens);
  const outputTokens = numberValue(source.outputTokens);
  const rawEndpoint = stringValue(source.kind ?? source.endpoint, 'CHAT');
  const endpoint = rawEndpoint.toUpperCase().replace('CHAT_COMPLETIONS', 'CHAT');
  const requestId = stringValue(source.requestId ?? source.id);
  return {
    ...source,
    id: stringValue(source.id, requestId),
    userEmail: source.userEmail ?? record(source.user).email,
    apiKeyName: source.apiKeyName ?? apiKey.name ?? null,
    model: source.model ?? source.modelAlias ?? '—',
    kind: endpoint,
    inputTokens,
    outputTokens,
    totalTokens: numberValue(source.totalTokens) || inputTokens + outputTokens,
    cachedInputTokens: numberValue(source.cachedInputTokens),
    reasoningTokens: numberValue(source.reasoningTokens),
    estimated: source.estimated ?? source.usageEstimated ?? false,
    amountUsd: stringValue(source.amountUsd ?? source.costUsd, '0'),
    inputPriceUsdPerMillion: stringValue(source.inputPriceUsdPerMillion, '0'),
    outputPriceUsdPerMillion: stringValue(source.outputPriceUsdPerMillion, '0'),
    retries: numberValue(source.retries ?? source.retryCount),
  };
}

function summarizeUsage(rows: UnknownRecord[]) {
  const summary = rows.reduce<UsageAccumulator>(
    (result, row) => {
      result.requests += 1;
      result.failedRequests += row.status === 'FAILED' ? 1 : 0;
      result.retries += numberValue(row.retries);
      result.inputTokens += numberValue(row.inputTokens);
      result.outputTokens += numberValue(row.outputTokens);
      result.totalTokens += numberValue(row.totalTokens);
      result.amountUsd += numberValue(row.amountUsd);
      result.latency += numberValue(row.latencyMs);
      return result;
    },
    {
      requests: 0,
      failedRequests: 0,
      retries: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      amountUsd: 0,
      latency: 0,
    },
  );
  const days = new Map<string, UnknownRecord>();
  rows.forEach((row) => {
    const created = stringValue(row.createdAt);
    const date = created ? created.slice(0, 10) : 'unknown';
    const point = days.get(date) ?? {
      date,
      requests: 0,
      tokens: 0,
      amountUsd: 0,
      failures: 0,
    };
    point.requests = numberValue(point.requests) + 1;
    point.tokens = numberValue(point.tokens) + numberValue(row.totalTokens);
    point.amountUsd = numberValue(point.amountUsd) + numberValue(row.amountUsd);
    point.failures = numberValue(point.failures) + (row.status === 'FAILED' ? 1 : 0);
    days.set(date, point);
  });
  return {
    summary: {
      ...summary,
      amountUsd: String(summary.amountUsd),
      averageLatencyMs: summary.requests ? Math.round(summary.latency / summary.requests) : 0,
    },
    series: [...days.values()].sort((a, b) =>
      stringValue(a.date).localeCompare(stringValue(b.date)),
    ),
  };
}

function normalizeUsage(payload: unknown): unknown {
  const source = record(payload);
  const rawRows = Array.isArray(payload)
    ? payload
    : Array.isArray(source.data)
      ? source.data
      : Array.isArray(source.items)
        ? source.items
        : [];
  const rows = rawRows.map(normalizeUsageRow);
  const computed = summarizeUsage(rows);
  return {
    ...source,
    data: rows,
    total: typeof source.total === 'number' ? source.total : rows.length,
    summary: source.summary ?? computed.summary,
    series: source.series ?? computed.series,
  };
}

function aggregateRanking(rows: unknown[], field: 'user' | 'model' | 'apiKey') {
  const values = new Map<
    string,
    { name: string; requests: number; tokens: number; amountUsd: number }
  >();
  rows.forEach((value) => {
    const row = normalizeUsageRow(value);
    const source = record(value);
    const name =
      field === 'user'
        ? stringValue(record(source.user).email, 'Unknown')
        : field === 'apiKey'
          ? stringValue(record(source.apiKey).name, 'Console session')
          : stringValue(record(source.publishedModel).defaultAlias ?? source.modelAlias, 'Unknown');
    const current = values.get(name) ?? { name, requests: 0, tokens: 0, amountUsd: 0 };
    current.requests += 1;
    current.tokens += numberValue(row.totalTokens);
    current.amountUsd += numberValue(row.amountUsd);
    values.set(name, current);
  });
  return [...values.values()]
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 8)
    .map((value) => ({ ...value, amountUsd: String(value.amountUsd) }));
}

function normalizeDashboard(payload: unknown): unknown {
  const source = record(payload);
  if (source.summary) return payload;
  const totals = record(source.totals);
  const recent = Array.isArray(source.recent) ? source.recent : [];
  const normalizedRecent = recent.map(normalizeUsageRow);
  const computed = summarizeUsage(normalizedRecent);
  return {
    summary: {
      requests: numberValue(totals.requests),
      failedRequests: numberValue(totals.failedRequests ?? totals.failures),
      retries: numberValue(totals.retries),
      inputTokens: numberValue(totals.inputTokens),
      outputTokens: numberValue(totals.outputTokens),
      totalTokens:
        numberValue(totals.totalTokens) ||
        numberValue(totals.inputTokens) + numberValue(totals.outputTokens),
      amountUsd: stringValue(totals.amountUsd ?? totals.costUsd, '0'),
      averageLatencyMs: numberValue(totals.averageLatencyMs),
    },
    series: computed.series,
    topModels: aggregateRanking(recent, 'model'),
    topUsers: aggregateRanking(recent, 'user'),
    topApiKeys: aggregateRanking(recent, 'apiKey'),
  };
}

function normalizeAudit(value: unknown): unknown {
  const source = record(value);
  return {
    ...source,
    actorEmail: source.actorEmail ?? record(source.actor).email ?? null,
    resourceType: source.resourceType ?? source.entityType ?? '—',
    resourceId: source.resourceId ?? source.entityId ?? null,
    changes: source.changes ?? source.metadata ?? null,
    ipAddress: source.ipAddress ?? null,
  };
}

export function normalizeApiPayload(path: string, payload: unknown): unknown {
  if (path === '/me') return normalizeIdentity(payload);
  if (path === '/admin/dashboard') return normalizeDashboard(payload);
  if (path.startsWith('/admin/providers')) {
    return mapCollection(payload, normalizeProvider);
  }
  if (path.startsWith('/admin/discovered-models')) {
    return mapCollection(payload, normalizeDiscoveredModel);
  }
  if (path.startsWith('/admin/models')) {
    return mapCollection(payload, normalizePublishedModel);
  }
  if (path.startsWith('/admin/users')) {
    return mapCollection(payload, normalizeUser);
  }
  if (path.startsWith('/admin/grants')) {
    return mapCollection(payload, normalizeGrant);
  }
  if (path.startsWith('/admin/audit')) {
    return mapCollection(payload, normalizeAudit);
  }
  if (path === '/me/models') return mapCollection(payload, normalizeModelOption);
  if (path.startsWith('/me/api-keys')) {
    return mapCollection(payload, normalizeApiKey);
  }
  if (path.startsWith('/me/usage') || path.startsWith('/admin/usage')) {
    return normalizeUsage(payload);
  }
  return payload;
}

export function normalizeRequestPayload(path: string, payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const source = payload as UnknownRecord;
  if (path.startsWith('/admin/providers')) {
    const { enabled, ...rest } = source;
    return {
      ...rest,
      type: source.type === 'OPENAI_COMPATIBLE' ? 'GENERIC_OPENAI' : source.type,
      active: enabled ?? source.active,
    };
  }
  if (path.startsWith('/admin/models')) {
    const { publicName, enabled, inputPriceUsdPerMillion, outputPriceUsdPerMillion, ...rest } =
      source;
    return {
      ...rest,
      defaultAlias: publicName ?? source.defaultAlias,
      active: enabled ?? source.active,
      inputPricePerM: inputPriceUsdPerMillion ?? source.inputPricePerM,
      outputPricePerM: outputPriceUsdPerMillion ?? source.outputPricePerM,
    };
  }
  if (path.startsWith('/admin/users')) {
    const { enabled, ...rest } = source;
    return { ...rest, active: enabled ?? source.active };
  }
  if (path.startsWith('/admin/grants')) {
    const { enabled, customInputPriceUsdPerMillion, customOutputPriceUsdPerMillion, ...rest } =
      source;
    return {
      ...rest,
      active: enabled ?? source.active,
      customInputPricePerM: customInputPriceUsdPerMillion ?? source.customInputPricePerM ?? null,
      customOutputPricePerM: customOutputPriceUsdPerMillion ?? source.customOutputPricePerM ?? null,
    };
  }
  return payload;
}
