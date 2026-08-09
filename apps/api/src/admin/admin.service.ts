import { Injectable } from '@nestjs/common';
import {
  Prisma,
  ProviderAuthMode,
  ProviderType,
  PromptMode,
  ThinkingLevel,
  UserRole,
} from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { SafeFetchService } from '../gateway/safe-fetch.service';
import { ProviderAdapterService } from '../gateway/provider-adapter.service';
import { AppError } from '../common/errors';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { ScanQueueService } from '../jobs/scan-queue.service';
import { UsageQueryService, type UsageHttpQuery } from '../usage/usage-query.service';

const providerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.nativeEnum(ProviderType),
  baseUrl: z.string().url().max(2048),
  authMode: z.nativeEnum(ProviderAuthMode).default(ProviderAuthMode.BEARER),
  secret: z.string().min(1).max(8192).optional(),
  timeoutMs: z.coerce.number().int().min(1000).max(600000).default(120000),
  active: z.boolean().default(true),
});

const modelSchema = z.object({
  providerId: z.string().uuid(),
  upstreamModelId: z.string().trim().min(1).max(255),
  defaultAlias: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._:/-]+$/),
  displayName: z.string().trim().max(255).optional().nullable(),
  capabilities: z.record(z.string(), z.union([z.boolean(), z.string()])).default({}),
  promptMode: z.nativeEnum(PromptMode).default(PromptMode.NONE),
  systemPrompt: z.string().max(100000).optional().nullable(),
  thinkingLevel: z.nativeEnum(ThinkingLevel).default(ThinkingLevel.PROVIDER_DEFAULT),
  maxRetries: z.coerce.number().int().min(0).max(5).default(0),
  inputPricePerM: z.coerce.number().nonnegative().max(1000000).default(0),
  outputPricePerM: z.coerce.number().nonnegative().max(1000000).default(0),
  active: z.boolean().default(true),
});

const userSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(255).optional().nullable(),
  keycloakSubject: z.string().max(255).optional().nullable(),
  role: z.nativeEnum(UserRole).default(UserRole.USER),
  active: z.boolean().default(true),
  temporaryPassword: z.string().min(12).max(1024).optional(),
});

const grantSchema = z.object({
  userId: z.string().uuid(),
  publishedModelId: z.string().uuid(),
  alias: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._:/-]+$/),
  customInputPricePerM: z.coerce.number().nonnegative().max(1000000).nullable().optional(),
  customOutputPricePerM: z.coerce.number().nonnegative().max(1000000).nullable().optional(),
  active: z.boolean().default(true),
});

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly safeFetch: SafeFetchService,
    private readonly adapters: ProviderAdapterService,
    private readonly keycloak: KeycloakAdminService,
    private readonly scanQueue: ScanQueueService,
    private readonly usageQuery: UsageQueryService,
  ) {}

  listProviders() {
    return this.prisma.providerConnection
      .findMany({
        select: {
          id: true,
          name: true,
          type: true,
          baseUrl: true,
          authMode: true,
          timeoutMs: true,
          active: true,
          healthStatus: true,
          lastHealthCheckAt: true,
          createdAt: true,
          updatedAt: true,
          encryptedSecret: true,
          _count: { select: { discoveredModels: true, publishedModels: true } },
        },
        orderBy: { name: 'asc' },
      })
      .then((items) =>
        items.map(({ encryptedSecret, ...item }) => ({
          ...item,
          hasSecret: Boolean(encryptedSecret),
        })),
      );
  }

  async createProvider(input: unknown, actor: AuthenticatedPrincipal, requestId: string) {
    const value = parse(providerSchema, input);
    await this.safeFetch.assertSafeDestination(new URL(value.baseUrl));
    const provider = await this.prisma.providerConnection.create({
      data: {
        name: value.name,
        type: value.type,
        baseUrl: value.baseUrl.replace(/\/$/, ''),
        authMode: value.authMode,
        encryptedSecret: value.secret ? this.crypto.encryptSecret(value.secret) : null,
        timeoutMs: value.timeoutMs,
        active: value.active,
      },
      select: {
        id: true,
        name: true,
        type: true,
        baseUrl: true,
        authMode: true,
        timeoutMs: true,
        active: true,
        healthStatus: true,
        createdAt: true,
      },
    });
    await this.audit(actor, 'provider.create', 'ProviderConnection', provider.id, requestId);
    return { ...provider, hasSecret: Boolean(value.secret) };
  }

  async updateProvider(
    id: string,
    input: unknown,
    actor: AuthenticatedPrincipal,
    requestId: string,
  ) {
    const value = parse(providerSchema.partial(), input);
    if (value.baseUrl) await this.safeFetch.assertSafeDestination(new URL(value.baseUrl));
    const provider = await this.prisma.providerConnection.update({
      where: { id },
      data: {
        name: value.name,
        type: value.type,
        baseUrl: value.baseUrl?.replace(/\/$/, ''),
        authMode: value.authMode,
        encryptedSecret: value.secret ? this.crypto.encryptSecret(value.secret) : undefined,
        timeoutMs: value.timeoutMs,
        active: value.active,
      },
      select: {
        id: true,
        name: true,
        type: true,
        baseUrl: true,
        authMode: true,
        timeoutMs: true,
        active: true,
        healthStatus: true,
        updatedAt: true,
        encryptedSecret: true,
      },
    });
    await this.audit(actor, 'provider.update', 'ProviderConnection', id, requestId);
    const { encryptedSecret, ...safe } = provider;
    return { ...safe, hasSecret: Boolean(encryptedSecret) };
  }

  async disableProvider(id: string, actor: AuthenticatedPrincipal, requestId: string) {
    const provider = await this.prisma.providerConnection.update({
      where: { id },
      data: { active: false },
    });
    await this.audit(actor, 'provider.disable', 'ProviderConnection', id, requestId);
    return { id: provider.id, active: provider.active };
  }

  async testProvider(id: string, actor: AuthenticatedPrincipal, requestId: string) {
    const provider = await this.prisma.providerConnection.findUnique({ where: { id } });
    if (!provider) throw new AppError('invalid_request_error', 404, 'The provider was not found.');
    try {
      const models = await this.adapters.scan(provider);
      await this.prisma.providerConnection.update({
        where: { id },
        data: { healthStatus: 'HEALTHY', lastHealthCheckAt: new Date() },
      });
      await this.audit(actor, 'provider.test', 'ProviderConnection', id, requestId, {
        status: 'HEALTHY',
        modelCount: models.length,
      });
      return { status: 'healthy', modelCount: models.length };
    } catch (error) {
      await this.prisma.providerConnection.update({
        where: { id },
        data: { healthStatus: 'UNHEALTHY', lastHealthCheckAt: new Date() },
      });
      await this.audit(actor, 'provider.test', 'ProviderConnection', id, requestId, {
        status: 'UNHEALTHY',
      });
      throw new AppError(
        'provider_unavailable',
        503,
        'The provider connection test failed.',
        null,
        error,
      );
    }
  }

  async scanProvider(id: string, actor: AuthenticatedPrincipal, requestId: string) {
    const provider = await this.prisma.providerConnection.findUnique({ where: { id } });
    if (!provider) throw new AppError('invalid_request_error', 404, 'The provider was not found.');
    const job = await this.prisma.scanJob.create({ data: { providerId: id, status: 'PENDING' } });
    try {
      await this.scanQueue.enqueue(job.id, requestId);
      await this.audit(actor, 'provider.scan.enqueue', 'ProviderConnection', id, requestId, {
        scanJobId: job.id,
      });
      return { jobId: job.id, status: 'PENDING', discoveredCount: 0 };
    } catch (error) {
      await this.prisma.scanJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', safeErrorCode: 'internal_error', finishedAt: new Date() },
      });
      throw new AppError(
        'provider_unavailable',
        503,
        'The provider scan could not be queued.',
        null,
        error,
      );
    }
  }

  listDiscovered(providerId?: string) {
    return this.prisma.discoveredModel.findMany({
      where: providerId ? { providerId } : undefined,
      include: { provider: { select: { id: true, name: true, type: true } } },
      orderBy: [{ providerId: 'asc' }, { upstreamModelId: 'asc' }],
    });
  }

  listModels() {
    return this.prisma.publishedModel.findMany({
      include: {
        provider: { select: { id: true, name: true, type: true, healthStatus: true } },
        _count: { select: { grants: true } },
      },
      orderBy: { defaultAlias: 'asc' },
    });
  }

  async createModel(input: unknown, actor: AuthenticatedPrincipal, requestId: string) {
    const value = parse(modelSchema, input);
    if (value.promptMode !== PromptMode.NONE && !value.systemPrompt) {
      throw new AppError(
        'invalid_request_error',
        400,
        'A system prompt is required for this prompt mode.',
        'systemPrompt',
      );
    }
    const model = await this.prisma.publishedModel.create({
      data: {
        ...value,
        capabilities: value.capabilities as Prisma.InputJsonValue,
        inputPricePerM: new Prisma.Decimal(value.inputPricePerM),
        outputPricePerM: new Prisma.Decimal(value.outputPricePerM),
      },
    });
    await this.audit(actor, 'model.create', 'PublishedModel', model.id, requestId);
    return model;
  }

  async updateModel(id: string, input: unknown, actor: AuthenticatedPrincipal, requestId: string) {
    const value = parse(modelSchema.partial(), input);
    const current = await this.prisma.publishedModel.findUnique({ where: { id } });
    if (!current)
      throw new AppError('invalid_request_error', 404, 'The published model was not found.');
    const effectivePromptMode = value.promptMode ?? current.promptMode;
    const effectiveSystemPrompt =
      value.systemPrompt === undefined ? current.systemPrompt : value.systemPrompt;
    if (effectivePromptMode !== PromptMode.NONE && !effectiveSystemPrompt) {
      throw new AppError(
        'invalid_request_error',
        400,
        'A system prompt is required for this prompt mode.',
        'systemPrompt',
      );
    }
    const model = await this.prisma.publishedModel.update({
      where: { id },
      data: {
        ...value,
        capabilities: value.capabilities as Prisma.InputJsonValue | undefined,
        inputPricePerM:
          value.inputPricePerM === undefined ? undefined : new Prisma.Decimal(value.inputPricePerM),
        outputPricePerM:
          value.outputPricePerM === undefined
            ? undefined
            : new Prisma.Decimal(value.outputPricePerM),
      },
    });
    await this.audit(actor, 'model.update', 'PublishedModel', id, requestId);
    return model;
  }

  listUsers() {
    return this.prisma.user.findMany({
      include: { _count: { select: { grants: true, apiKeys: true, inferenceRequests: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createUser(input: unknown, actor: AuthenticatedPrincipal, requestId: string) {
    const value = parse(userSchema, input);
    const provisioned = await this.keycloak.provisionUser({
      email: value.email,
      displayName: value.displayName,
      role: value.role,
      active: value.active,
      temporaryPassword: value.temporaryPassword,
    });
    const { temporaryPassword: _temporaryPassword, ...userData } = value;
    let user;
    try {
      user = await this.prisma.user.create({
        data: { ...userData, keycloakSubject: provisioned.id },
      });
    } catch (error) {
      if (provisioned.newlyCreated)
        await this.keycloak.deleteUser(provisioned.id).catch(() => undefined);
      throw error;
    }
    await this.audit(actor, 'user.create', 'User', user.id, requestId);
    return { ...user, generatedTemporaryPassword: provisioned.generatedTemporaryPassword };
  }

  async updateUser(id: string, input: unknown, actor: AuthenticatedPrincipal, requestId: string) {
    const value = parse(userSchema.partial(), input);
    const current = await this.prisma.user.findUnique({ where: { id } });
    if (!current) throw new AppError('invalid_request_error', 404, 'The user was not found.');
    if (current.keycloakSubject) {
      await this.keycloak.updateUser(current.keycloakSubject, {
        displayName: value.displayName,
        role: value.role,
        active: value.active,
      });
    }
    const { temporaryPassword: _temporaryPassword, ...userData } = value;
    const user = await this.prisma.user.update({ where: { id }, data: userData });
    await this.audit(actor, 'user.update', 'User', id, requestId);
    return user;
  }

  listGrants(userId?: string) {
    return this.prisma.userModelGrant.findMany({
      where: userId ? { userId } : undefined,
      include: {
        user: { select: { id: true, email: true, displayName: true } },
        publishedModel: { select: { id: true, defaultAlias: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async upsertGrant(input: unknown, actor: AuthenticatedPrincipal, requestId: string) {
    const value = parse(grantSchema, input);
    const grant = await this.prisma.userModelGrant.upsert({
      where: {
        userId_publishedModelId: { userId: value.userId, publishedModelId: value.publishedModelId },
      },
      create: value,
      update: {
        alias: value.alias,
        active: value.active,
        customInputPricePerM: value.customInputPricePerM,
        customOutputPricePerM: value.customOutputPricePerM,
      },
    });
    await this.audit(actor, 'grant.upsert', 'UserModelGrant', grant.id, requestId);
    return grant;
  }

  async deleteGrant(id: string, actor: AuthenticatedPrincipal, requestId: string) {
    await this.prisma.userModelGrant.delete({ where: { id } });
    await this.audit(actor, 'grant.delete', 'UserModelGrant', id, requestId);
    return { id, deleted: true };
  }

  dashboard() {
    return this.usageQuery.dashboard();
  }

  listAttempts(limit = 100) {
    return this.prisma.providerAttempt.findMany({
      take: Math.min(Math.max(limit, 1), 500),
      orderBy: { startedAt: 'desc' },
      include: {
        provider: { select: { id: true, name: true, type: true } },
        inferenceRequest: {
          select: { requestId: true, modelAlias: true, userId: true, endpoint: true },
        },
      },
    });
  }

  usage(query: UsageHttpQuery = {}) {
    return this.usageQuery.query(query);
  }

  usageCsv(query: UsageHttpQuery = {}) {
    return this.usageQuery.exportCsv(query);
  }

  listAudit(limit = 100) {
    return this.prisma.auditLog.findMany({
      take: Math.min(Math.max(limit, 1), 500),
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { email: true } } },
    });
  }

  private audit(
    actor: AuthenticatedPrincipal,
    action: string,
    entityType: string,
    entityId: string,
    requestId: string,
    metadata?: Prisma.InputJsonObject,
  ) {
    return this.prisma.auditLog.create({
      data: { actorUserId: actor.userId, action, entityType, entityId, requestId, metadata },
    });
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AppError(
      'invalid_request_error',
      400,
      issue?.message ?? 'The request is invalid.',
      issue?.path.join('.') || null,
    );
  }
  return result.data;
}
