import { Injectable } from '@nestjs/common';
import { Prisma, RequestSource, RequestStatus } from '@prisma/client';
import { AppError } from '../common/errors';
import { PrismaService } from '../database/prisma.service';

export type UsageHttpQuery = Record<string, string | string[] | undefined>;

interface NormalizedUsageQuery {
  page: number;
  pageSize: number;
  from?: Date;
  toExclusive?: Date;
  user?: string;
  model?: string;
  apiKey?: string;
  endpoint?: string;
  source?: RequestSource;
  status?: RequestStatus;
}

interface SummaryRow {
  requests: number | bigint;
  failedRequests: number | bigint;
  retries: number | bigint;
  inputTokens: number | bigint;
  outputTokens: number | bigint;
  amountUsd: string | Prisma.Decimal;
  averageLatencyMs: number | bigint;
}

interface SeriesRow {
  date: string;
  requests: number | bigint;
  tokens: number | bigint;
  amountUsd: string | Prisma.Decimal;
  failures: number | bigint;
}

interface RankingRow {
  name: string;
  requests: number | bigint;
  tokens: number | bigint;
  amountUsd: string | Prisma.Decimal;
}

const ROW_SELECT = {
  id: true,
  requestId: true,
  userId: true,
  apiKeyId: true,
  endpoint: true,
  source: true,
  modelAlias: true,
  status: true,
  streamed: true,
  inputTokens: true,
  cachedInputTokens: true,
  outputTokens: true,
  reasoningTokens: true,
  usageEstimated: true,
  inputPriceSnapshot: true,
  outputPriceSnapshot: true,
  costUsd: true,
  retryCount: true,
  safeErrorCode: true,
  latencyMs: true,
  createdAt: true,
  completedAt: true,
  user: { select: { id: true, email: true, displayName: true } },
  apiKey: { select: { id: true, name: true, prefix: true, lastFour: true } },
} satisfies Prisma.InferenceRequestSelect;

const EXPORT_ROW_LIMIT = 100_000;

@Injectable()
export class UsageQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async query(input: UsageHttpQuery = {}, fixedUserId?: string) {
    const query = normalizeUsageQuery(input);
    const where = buildPrismaWhere(query, fixedUserId);
    const sqlWhere = buildSqlWhere(query, fixedUserId);
    const skip = (query.page - 1) * query.pageSize;

    const [rows, total, summaryRows, seriesRows] = await Promise.all([
      this.prisma.inferenceRequest.findMany({
        where,
        skip,
        take: query.pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: ROW_SELECT,
      }),
      this.prisma.inferenceRequest.count({ where }),
      this.prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
        SELECT
          COUNT(*)::bigint AS "requests",
          COUNT(*) FILTER (WHERE r."status"::text = 'FAILED')::bigint AS "failedRequests",
          COALESCE(SUM(r."retry_count"), 0)::bigint AS "retries",
          COALESCE(SUM(r."input_tokens"), 0)::bigint AS "inputTokens",
          COALESCE(SUM(r."output_tokens"), 0)::bigint AS "outputTokens",
          COALESCE(SUM(r."cost_usd"), 0)::text AS "amountUsd",
          COALESCE(ROUND(AVG(r."latency_ms")), 0)::bigint AS "averageLatencyMs"
        FROM "app"."inference_requests" r
        ${sqlWhere}
      `),
      this.prisma.$queryRaw<SeriesRow[]>(Prisma.sql`
        SELECT
          to_char(r."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "date",
          COUNT(*)::bigint AS "requests",
          COALESCE(SUM(r."input_tokens" + r."output_tokens"), 0)::bigint AS "tokens",
          COALESCE(SUM(r."cost_usd"), 0)::text AS "amountUsd",
          COUNT(*) FILTER (WHERE r."status"::text = 'FAILED')::bigint AS "failures"
        FROM "app"."inference_requests" r
        ${sqlWhere}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
    ]);

    return {
      data: rows.map(toUsageDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
      summary: toSummary(summaryRows[0]),
      series: seriesRows.map(toSeriesPoint),
    };
  }

  async exportCsv(input: UsageHttpQuery = {}, fixedUserId?: string): Promise<string> {
    const query = normalizeUsageQuery(input);
    const rows = await this.prisma.inferenceRequest.findMany({
      where: buildPrismaWhere(query, fixedUserId),
      take: EXPORT_ROW_LIMIT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: ROW_SELECT,
    });
    const columns = [
      'request_id',
      'created_at',
      'user_email',
      'api_key',
      'endpoint',
      'source',
      'model',
      'status',
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'estimated',
      'input_price_per_m',
      'output_price_per_m',
      'cost_usd',
      'retries',
      'latency_ms',
      'safe_error_code',
    ];
    return [
      columns.join(','),
      ...rows.map((row) =>
        [
          row.requestId,
          row.createdAt.toISOString(),
          row.user.email,
          row.apiKey?.name ?? '',
          row.endpoint,
          row.source,
          row.modelAlias,
          row.status,
          row.inputTokens,
          row.cachedInputTokens,
          row.outputTokens,
          row.reasoningTokens,
          row.usageEstimated,
          row.inputPriceSnapshot.toString(),
          row.outputPriceSnapshot.toString(),
          row.costUsd.toString(),
          row.retryCount,
          row.latencyMs ?? '',
          row.safeErrorCode ?? '',
        ]
          .map(csvCell)
          .join(','),
      ),
    ].join('\n');
  }

  async dashboard(fixedUserId?: string) {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
    const toExclusive = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    const query: NormalizedUsageQuery = { page: 1, pageSize: 1, from, toExclusive };
    const where = buildSqlWhere(query, fixedUserId);
    const topUsersQuery: Promise<RankingRow[]> = fixedUserId
      ? Promise.resolve([])
      : this.ranking(
          Prisma.sql`COALESCE(u."email", 'Unknown')`,
          where,
          Prisma.sql`JOIN "app"."users" u ON u."id" = r."user_id"`,
        );
    const topApiKeysQuery: Promise<RankingRow[]> = fixedUserId
      ? Promise.resolve([])
      : this.ranking(
          Prisma.sql`COALESCE(k."name", 'Console session')`,
          where,
          Prisma.sql`LEFT JOIN "app"."api_keys" k ON k."id" = r."api_key_id"`,
        );
    const [summaryRows, seriesRows, topModels, topUsers, topApiKeys] = await Promise.all([
      this.prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
        SELECT
          COUNT(*)::bigint AS "requests",
          COUNT(*) FILTER (WHERE r."status"::text = 'FAILED')::bigint AS "failedRequests",
          COALESCE(SUM(r."retry_count"), 0)::bigint AS "retries",
          COALESCE(SUM(r."input_tokens"), 0)::bigint AS "inputTokens",
          COALESCE(SUM(r."output_tokens"), 0)::bigint AS "outputTokens",
          COALESCE(SUM(r."cost_usd"), 0)::text AS "amountUsd",
          COALESCE(ROUND(AVG(r."latency_ms")), 0)::bigint AS "averageLatencyMs"
        FROM "app"."inference_requests" r
        ${where}
      `),
      this.prisma.$queryRaw<SeriesRow[]>(Prisma.sql`
        SELECT
          to_char(r."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "date",
          COUNT(*)::bigint AS "requests",
          COALESCE(SUM(r."input_tokens" + r."output_tokens"), 0)::bigint AS "tokens",
          COALESCE(SUM(r."cost_usd"), 0)::text AS "amountUsd",
          COUNT(*) FILTER (WHERE r."status"::text = 'FAILED')::bigint AS "failures"
        FROM "app"."inference_requests" r
        ${where}
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      this.ranking(Prisma.sql`r."model_alias"`, where),
      topUsersQuery,
      topApiKeysQuery,
    ]);

    return {
      summary: toSummary(summaryRows[0]),
      series: fillDailySeries(from, now, seriesRows.map(toSeriesPoint)),
      topModels: topModels.map(toRanking),
      topUsers: topUsers.map(toRanking),
      topApiKeys: topApiKeys.map(toRanking),
    };
  }

  private ranking(label: Prisma.Sql, where: Prisma.Sql, join: Prisma.Sql = Prisma.empty) {
    return this.prisma.$queryRaw<RankingRow[]>(Prisma.sql`
      SELECT
        ${label} AS "name",
        COUNT(*)::bigint AS "requests",
        COALESCE(SUM(r."input_tokens" + r."output_tokens"), 0)::bigint AS "tokens",
        COALESCE(SUM(r."cost_usd"), 0)::text AS "amountUsd"
      FROM "app"."inference_requests" r
      ${join}
      ${where}
      GROUP BY 1
      ORDER BY COUNT(*) DESC, COALESCE(SUM(r."input_tokens" + r."output_tokens"), 0) DESC
      LIMIT 8
    `);
  }
}

function normalizeUsageQuery(input: UsageHttpQuery): NormalizedUsageQuery {
  const page = integerQuery(input.page, 1, 1, 1_000_000);
  const pageSize = integerQuery(input.pageSize ?? input.limit, 20, 1, 500);
  const range = scalar(input.range);
  const explicitFrom = parseDate(scalar(input.from), 'from');
  const explicitTo = parseEndDate(scalar(input.to));
  let from = explicitFrom;
  let toExclusive = explicitTo;
  if (!from && !toExclusive && range) {
    const match = /^(\d{1,3})d$/i.exec(range);
    if (!match) throw invalidQuery('range');
    const days = Math.min(Math.max(Number(match[1]), 1), 366);
    const now = new Date();
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1));
    toExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  }
  if (from && toExclusive && from >= toExclusive) throw invalidQuery('to');

  const kind = scalar(input.kind)?.toUpperCase();
  const endpoint = kind
    ? { CHAT: 'chat', CHAT_COMPLETIONS: 'chat', RESPONSES: 'responses', EMBEDDINGS: 'embeddings' }[
        kind
      ]
    : undefined;
  if (kind && !endpoint) throw invalidQuery('kind');
  const sourceValue = scalar(input.source)?.toUpperCase();
  const source = sourceValue ? parseEnum(RequestSource, sourceValue, 'source') : undefined;
  const statusValue = scalar(input.status)?.toUpperCase();
  const normalizedStatus = statusValue === 'PENDING' ? 'RUNNING' : statusValue;
  const status = normalizedStatus
    ? parseEnum(RequestStatus, normalizedStatus, 'status')
    : undefined;

  return {
    page,
    pageSize,
    from,
    toExclusive,
    user: cleanSearch(input.user),
    model: cleanSearch(input.model),
    apiKey: cleanSearch(input.apiKey),
    endpoint,
    source,
    status,
  };
}

function buildPrismaWhere(
  query: NormalizedUsageQuery,
  fixedUserId?: string,
): Prisma.InferenceRequestWhereInput {
  const and: Prisma.InferenceRequestWhereInput[] = [];
  if (fixedUserId) and.push({ userId: fixedUserId });
  if (query.from || query.toExclusive) {
    and.push({ createdAt: { gte: query.from, lt: query.toExclusive } });
  }
  if (query.user && !fixedUserId) {
    if (isUuid(query.user)) and.push({ userId: query.user });
    else
      and.push({
        user: {
          is: {
            OR: [
              { email: { contains: query.user, mode: 'insensitive' } },
              { displayName: { contains: query.user, mode: 'insensitive' } },
            ],
          },
        },
      });
  }
  if (query.model) and.push({ modelAlias: { contains: query.model, mode: 'insensitive' } });
  if (query.apiKey) {
    if (query.apiKey.toLowerCase() === 'console') and.push({ apiKeyId: null });
    else if (isUuid(query.apiKey)) and.push({ apiKeyId: query.apiKey });
    else
      and.push({
        apiKey: {
          is: {
            OR: [
              { name: { contains: query.apiKey, mode: 'insensitive' } },
              { prefix: { contains: query.apiKey, mode: 'insensitive' } },
              { lastFour: { contains: query.apiKey, mode: 'insensitive' } },
            ],
          },
        },
      });
  }
  if (query.endpoint) and.push({ endpoint: query.endpoint });
  if (query.source) and.push({ source: query.source });
  if (query.status) and.push({ status: query.status });
  return and.length ? { AND: and } : {};
}

function buildSqlWhere(query: NormalizedUsageQuery, fixedUserId?: string): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (fixedUserId) conditions.push(Prisma.sql`r."user_id" = ${fixedUserId}::uuid`);
  if (query.from) conditions.push(Prisma.sql`r."created_at" >= ${query.from}`);
  if (query.toExclusive) conditions.push(Prisma.sql`r."created_at" < ${query.toExclusive}`);
  if (query.user && !fixedUserId) {
    if (isUuid(query.user)) conditions.push(Prisma.sql`r."user_id" = ${query.user}::uuid`);
    else {
      const pattern = containsPattern(query.user);
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "app"."users" filter_user
        WHERE filter_user."id" = r."user_id"
          AND (filter_user."email" ILIKE ${pattern} ESCAPE '\\' OR filter_user."display_name" ILIKE ${pattern} ESCAPE '\\')
      )`);
    }
  }
  if (query.model)
    conditions.push(Prisma.sql`r."model_alias" ILIKE ${containsPattern(query.model)} ESCAPE '\\'`);
  if (query.apiKey) {
    if (query.apiKey.toLowerCase() === 'console')
      conditions.push(Prisma.sql`r."api_key_id" IS NULL`);
    else if (isUuid(query.apiKey))
      conditions.push(Prisma.sql`r."api_key_id" = ${query.apiKey}::uuid`);
    else {
      const pattern = containsPattern(query.apiKey);
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "app"."api_keys" filter_key
        WHERE filter_key."id" = r."api_key_id"
          AND (filter_key."name" ILIKE ${pattern} ESCAPE '\\' OR filter_key."prefix" ILIKE ${pattern} ESCAPE '\\' OR filter_key."last_four" ILIKE ${pattern} ESCAPE '\\')
      )`);
    }
  }
  if (query.endpoint) conditions.push(Prisma.sql`r."endpoint" = ${query.endpoint}`);
  if (query.source) conditions.push(Prisma.sql`r."source"::text = ${query.source}`);
  if (query.status) conditions.push(Prisma.sql`r."status"::text = ${query.status}`);
  return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}

function toUsageDto(row: Prisma.InferenceRequestGetPayload<{ select: typeof ROW_SELECT }>) {
  return {
    ...row,
    userEmail: row.user.email,
    apiKeyName: row.apiKey?.name ?? null,
    model: row.modelAlias,
    kind: endpointKind(row.endpoint),
    estimated: row.usageEstimated,
    totalTokens: row.inputTokens + row.outputTokens,
    amountUsd: row.costUsd.toString(),
    inputPriceUsdPerMillion: row.inputPriceSnapshot.toString(),
    outputPriceUsdPerMillion: row.outputPriceSnapshot.toString(),
    retries: row.retryCount,
  };
}

function toSummary(row?: SummaryRow) {
  const inputTokens = safeNumber(row?.inputTokens);
  const outputTokens = safeNumber(row?.outputTokens);
  return {
    requests: safeNumber(row?.requests),
    failedRequests: safeNumber(row?.failedRequests),
    retries: safeNumber(row?.retries),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    amountUsd: String(row?.amountUsd ?? '0'),
    averageLatencyMs: safeNumber(row?.averageLatencyMs),
  };
}

function toSeriesPoint(row: SeriesRow) {
  return {
    date: row.date,
    requests: safeNumber(row.requests),
    tokens: safeNumber(row.tokens),
    amountUsd: Number(String(row.amountUsd ?? '0')),
    failures: safeNumber(row.failures),
  };
}

function toRanking(row: RankingRow) {
  return {
    name: row.name,
    requests: safeNumber(row.requests),
    tokens: safeNumber(row.tokens),
    amountUsd: String(row.amountUsd ?? '0'),
  };
}

function fillDailySeries(from: Date, through: Date, points: ReturnType<typeof toSeriesPoint>[]) {
  const byDate = new Map(points.map((point) => [point.date, point]));
  const result: ReturnType<typeof toSeriesPoint>[] = [];
  const cursor = new Date(from);
  const end = new Date(
    Date.UTC(through.getUTCFullYear(), through.getUTCMonth(), through.getUTCDate()),
  );
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    result.push(byDate.get(date) ?? { date, requests: 0, tokens: 0, amountUsd: 0, failures: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function endpointKind(endpoint: string): string {
  if (endpoint === 'chat') return 'CHAT';
  if (endpoint === 'responses') return 'RESPONSES';
  if (endpoint === 'embeddings') return 'EMBEDDINGS';
  return endpoint.toUpperCase();
}

function scalar(value: string | string[] | undefined): string | undefined {
  const selected = Array.isArray(value) ? value[0] : value;
  const trimmed = selected?.trim();
  return trimmed || undefined;
}

function cleanSearch(value: string | string[] | undefined): string | undefined {
  const result = scalar(value);
  if (!result) return undefined;
  if (result.length > 255)
    throw new AppError('invalid_request_error', 400, 'A usage filter is too long.');
  return result;
}

function integerQuery(
  value: string | string[] | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = scalar(value);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw))
    throw new AppError('invalid_request_error', 400, 'A pagination value is invalid.');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed))
    throw new AppError('invalid_request_error', 400, 'A pagination value is invalid.');
  return Math.min(Math.max(parsed, minimum), maximum);
}

function parseDate(value: string | undefined, param: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw invalidQuery(param);
  return parsed;
}

function parseEndDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime())) throw invalidQuery('to');
    parsed.setUTCDate(parsed.getUTCDate() + 1);
    return parsed;
  }
  const parsed = parseDate(value, 'to');
  return parsed;
}

function parseEnum<T extends Record<string, string>>(
  values: T,
  value: string,
  param: string,
): T[keyof T] {
  if (!Object.values(values).includes(value)) throw invalidQuery(param);
  return value as T[keyof T];
}

function invalidQuery(param: string): AppError {
  return new AppError('invalid_request_error', 400, 'A usage filter is invalid.', param);
}

function containsPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeNumber(value: number | bigint | null | undefined): number {
  if (typeof value === 'bigint')
    return Number(
      value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value,
    );
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
