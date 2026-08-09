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

const grantAliasPattern = /^[A-Za-z0-9._:/-]+$/;

const grantSchema = z.object({
  userId: z.string().uuid(),
  publishedModelId: z.string().uuid(),
  alias: z
    .string()
    .trim()
    .max(255)
    .refine((value) => value.length === 0 || grantAliasPattern.test(value), {
      message: 'The model alias contains unsupported characters.',
    })
    .optional()
    .nullable(),
  customInputPricePerM: z.coerce.number().nonnegative().max(1000000).nullable().optional(),
  customOutputPricePerM: z.coerce.number().nonnegative().max(1000000).nullable().optional(),
  active: z.boolean().default(true),
});

const grantBatchSchema = z.object({
  publishedModelIds: z.array(z.string().uuid()).min(1).max(5000).optional(),
  // Kept as a request-only compatibility alias. Responses and documentation
  // use publishedModelIds so there is one canonical public name.
  modelIds: z.array(z.string().uuid()).min(1).max(5000).optional(),
});

export interface AdminDeleteResult {
  id: string;
  deleted: true;
  hidden: true;
  mode: 'HARD_DELETE' | 'ARCHIVED';
  reason: null | 'HISTORY_PRESERVED';
}

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
        where: { deletedAt: null },
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
          _count: {
            select: {
              discoveredModels: true,
              publishedModels: { where: { deletedAt: null } },
            },
          },
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
    await this.requireProvider(id);
    if (value.baseUrl) await this.safeFetch.assertSafeDestination(new URL(value.baseUrl));
    let provider;
    try {
      provider = await this.prisma.providerConnection.update({
        where: { id, deletedAt: null },
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
    } catch (error) {
      if (isRecordNotFoundError(error)) throw providerNotFound();
      throw error;
    }
    await this.audit(actor, 'provider.update', 'ProviderConnection', id, requestId);
    const { encryptedSecret, ...safe } = provider;
    return { ...safe, hasSecret: Boolean(encryptedSecret) };
  }

  async deleteProvider(
    id: string,
    actor: AuthenticatedPrincipal,
    requestId: string,
  ): Promise<AdminDeleteResult> {
    try {
      await this.withSerializableTransaction(async (tx) => {
        // Models without immutable usage history can be removed together with
        // the provider. RESTRICT relations make this transaction fail safely
        // when inference, usage, or attempt history must be retained.
        await tx.publishedModel.deleteMany({ where: { providerId: id } });
        const deleted = await tx.providerConnection.deleteMany({
          where: { id, deletedAt: null },
        });
        if (deleted.count === 0) throw providerNotFound();
        await this.audit(
          actor,
          'provider.delete',
          'ProviderConnection',
          id,
          requestId,
          undefined,
          tx,
        );
      });
      return { id, deleted: true, hidden: true, mode: 'HARD_DELETE', reason: null };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (!isForeignKeyConstraintError(error)) throw error;
    }

    const deletedAt = new Date();
    await this.withSerializableTransaction(async (tx) => {
      const current = await tx.providerConnection.findFirst({
        where: { id, deletedAt: null },
        select: { name: true },
      });
      if (!current) throw providerNotFound();
      const models = await tx.publishedModel.findMany({
        where: { providerId: id, deletedAt: null },
        select: { id: true, defaultAlias: true },
      });
      // Grants are configuration, not usage history. Removing them releases
      // user aliases while inference and rollup rows remain linked to models.
      await tx.userModelGrant.deleteMany({
        where: { publishedModel: { providerId: id } },
      });
      for (const model of models) {
        await tx.publishedModel.update({
          where: { id: model.id },
          data: {
            active: false,
            deletedAt,
            defaultAlias: deletedModelAlias(model.defaultAlias, model.id),
          },
        });
      }
      await tx.providerConnection.update({
        where: { id },
        data: {
          active: false,
          deletedAt,
          encryptedSecret: null,
          name: deletedProviderName(current.name, id),
        },
      });
      await this.audit(
        actor,
        'provider.archive',
        'ProviderConnection',
        id,
        requestId,
        {
          reason: 'HISTORY_PRESERVED',
          originalName: current.name,
          publishedModelCount: models.length,
        },
        tx,
      );
    });
    return {
      id,
      deleted: true,
      hidden: true,
      mode: 'ARCHIVED',
      reason: 'HISTORY_PRESERVED',
    };
  }

  async testProvider(id: string, actor: AuthenticatedPrincipal, requestId: string) {
    const provider = await this.requireProvider(id);
    try {
      const models = await this.adapters.scan(provider);
      await this.prisma.providerConnection.updateMany({
        where: { id, deletedAt: null },
        data: { healthStatus: 'HEALTHY', lastHealthCheckAt: new Date() },
      });
      await this.audit(actor, 'provider.test', 'ProviderConnection', id, requestId, {
        status: 'HEALTHY',
        modelCount: models.length,
      });
      return { status: 'healthy', modelCount: models.length };
    } catch (error) {
      await this.prisma.providerConnection.updateMany({
        where: { id, deletedAt: null },
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
    const job = await this.withSerializableTransaction(async (tx) => {
      await this.requireProvider(id, tx);
      return tx.scanJob.create({ data: { providerId: id, status: 'PENDING' } });
    });
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
      where: {
        ...(providerId ? { providerId } : {}),
        provider: { deletedAt: null },
      },
      include: { provider: { select: { id: true, name: true, type: true } } },
      orderBy: [{ providerId: 'asc' }, { upstreamModelId: 'asc' }],
    });
  }

  listModels() {
    return this.prisma.publishedModel.findMany({
      where: { deletedAt: null, provider: { deletedAt: null } },
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
    return this.withSerializableTransaction(async (tx) => {
      await this.requireProvider(value.providerId, tx);
      const model = await tx.publishedModel.create({
        data: {
          ...value,
          capabilities: value.capabilities as Prisma.InputJsonValue,
          inputPricePerM: new Prisma.Decimal(value.inputPricePerM),
          outputPricePerM: new Prisma.Decimal(value.outputPricePerM),
        },
      });
      await this.audit(actor, 'model.create', 'PublishedModel', model.id, requestId, undefined, tx);
      return model;
    });
  }

  async updateModel(id: string, input: unknown, actor: AuthenticatedPrincipal, requestId: string) {
    const value = parse(modelSchema.partial(), input);
    return this.withSerializableTransaction(async (tx) => {
      const current = await tx.publishedModel.findFirst({
        where: { id, deletedAt: null, provider: { deletedAt: null } },
      });
      if (!current) throw modelNotFound();
      if (value.providerId && value.providerId !== current.providerId) {
        await this.requireProvider(value.providerId, tx);
      }
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
      let model;
      try {
        model = await tx.publishedModel.update({
          where: { id, deletedAt: null },
          data: {
            ...value,
            capabilities: value.capabilities as Prisma.InputJsonValue | undefined,
            inputPricePerM:
              value.inputPricePerM === undefined
                ? undefined
                : new Prisma.Decimal(value.inputPricePerM),
            outputPricePerM:
              value.outputPricePerM === undefined
                ? undefined
                : new Prisma.Decimal(value.outputPricePerM),
          },
        });
      } catch (error) {
        if (isRecordNotFoundError(error)) throw modelNotFound();
        throw error;
      }
      await this.audit(actor, 'model.update', 'PublishedModel', id, requestId, undefined, tx);
      return model;
    });
  }

  async deleteModel(
    id: string,
    actor: AuthenticatedPrincipal,
    requestId: string,
  ): Promise<AdminDeleteResult> {
    try {
      await this.withSerializableTransaction(async (tx) => {
        const deleted = await tx.publishedModel.deleteMany({
          where: { id, deletedAt: null, provider: { deletedAt: null } },
        });
        if (deleted.count === 0) throw modelNotFound();
        await this.audit(actor, 'model.delete', 'PublishedModel', id, requestId, undefined, tx);
      });
      return { id, deleted: true, hidden: true, mode: 'HARD_DELETE', reason: null };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (!isForeignKeyConstraintError(error)) throw error;
    }

    const deletedAt = new Date();
    await this.withSerializableTransaction(async (tx) => {
      const current = await tx.publishedModel.findFirst({
        where: { id, deletedAt: null, provider: { deletedAt: null } },
        select: { defaultAlias: true },
      });
      if (!current) throw modelNotFound();
      await tx.userModelGrant.deleteMany({
        where: { publishedModelId: id },
      });
      await tx.publishedModel.update({
        where: { id },
        data: {
          active: false,
          deletedAt,
          defaultAlias: deletedModelAlias(current.defaultAlias, id),
        },
      });
      await this.audit(
        actor,
        'model.archive',
        'PublishedModel',
        id,
        requestId,
        { reason: 'HISTORY_PRESERVED', originalAlias: current.defaultAlias },
        tx,
      );
    });
    return {
      id,
      deleted: true,
      hidden: true,
      mode: 'ARCHIVED',
      reason: 'HISTORY_PRESERVED',
    };
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
      where: {
        ...(userId ? { userId } : {}),
        publishedModel: { deletedAt: null, provider: { deletedAt: null } },
      },
      include: {
        user: { select: { id: true, email: true, displayName: true } },
        publishedModel: { select: { id: true, defaultAlias: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async upsertGrant(input: unknown, actor: AuthenticatedPrincipal, requestId: string) {
    const value = parse(grantSchema, input);
    try {
      return await this.withSerializableTransaction(async (tx) => {
        await this.requireUser(value.userId, tx);
        const model = await this.requireModel(value.publishedModelId, tx);
        const alias = validateGrantAlias(value.alias || model.upstreamModelId, 'alias');
        const conflictingGrant = await tx.userModelGrant.findFirst({
          where: {
            userId: value.userId,
            alias,
            NOT: { publishedModelId: value.publishedModelId },
          },
          select: { id: true },
        });
        if (conflictingGrant) throw grantAliasConflict('alias');
        const grant = await tx.userModelGrant.upsert({
          where: {
            userId_publishedModelId: {
              userId: value.userId,
              publishedModelId: value.publishedModelId,
            },
          },
          create: { ...value, alias },
          update: {
            alias,
            active: value.active,
            customInputPricePerM: value.customInputPricePerM,
            customOutputPricePerM: value.customOutputPricePerM,
          },
        });
        await this.audit(
          actor,
          'grant.upsert',
          'UserModelGrant',
          grant.id,
          requestId,
          undefined,
          tx,
        );
        return grant;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw grantAliasConflict('alias');
      throw error;
    }
  }

  async createGrantsBatch(
    userId: string,
    input: unknown,
    actor: AuthenticatedPrincipal,
    requestId: string,
  ) {
    userId = parse(z.object({ userId: z.string().uuid() }), { userId }).userId;
    const value = parse(grantBatchSchema, input);
    const requestedIds = value.publishedModelIds ?? value.modelIds;
    if (!requestedIds) {
      throw new AppError(
        'invalid_request_error',
        400,
        'At least one published model must be selected.',
        'publishedModelIds',
      );
    }
    const publishedModelIds = [...new Set(requestedIds)];

    try {
      return await this.withSerializableTransaction(async (tx) => {
        await this.requireUser(userId, tx);
        const models = await tx.publishedModel.findMany({
          where: {
            id: { in: publishedModelIds },
            deletedAt: null,
            provider: { deletedAt: null },
          },
          select: { id: true, upstreamModelId: true },
        });
        if (models.length !== publishedModelIds.length) throw batchModelsNotFound();

        const modelById = new Map(models.map((model) => [model.id, model]));
        const orderedModels = publishedModelIds.map((id) => modelById.get(id)!);
        const existingForModels = await tx.userModelGrant.findMany({
          where: { userId, publishedModelId: { in: publishedModelIds } },
          select: { publishedModelId: true },
        });
        const existingModelIds = new Set(existingForModels.map((grant) => grant.publishedModelId));
        const candidates = orderedModels
          .filter((model) => !existingModelIds.has(model.id))
          .map((model) => ({
            userId,
            publishedModelId: model.id,
            alias: validateGrantAlias(model.upstreamModelId, 'publishedModelIds'),
            active: true,
            customInputPricePerM: null,
            customOutputPricePerM: null,
          }));

        const aliases = candidates.map((candidate) => candidate.alias);
        if (new Set(aliases).size !== aliases.length) {
          throw grantAliasConflict('publishedModelIds');
        }
        if (aliases.length > 0) {
          const conflictingGrant = await tx.userModelGrant.findFirst({
            where: { userId, alias: { in: aliases } },
            select: { id: true },
          });
          if (conflictingGrant) throw grantAliasConflict('publishedModelIds');
          await tx.userModelGrant.createMany({ data: candidates });
        }

        const grants = await tx.userModelGrant.findMany({
          where: { userId, publishedModelId: { in: publishedModelIds } },
          orderBy: { createdAt: 'asc' },
        });
        const createdModelIds = new Set(candidates.map((candidate) => candidate.publishedModelId));
        const createdGrants = grants.filter((grant) => createdModelIds.has(grant.publishedModelId));
        if (createdGrants.length > 0) {
          await tx.auditLog.createMany({
            data: createdGrants.map((grant) => ({
              actorUserId: actor.userId,
              action: 'grant.batch.create',
              entityType: 'UserModelGrant',
              entityId: grant.id,
              requestId,
              metadata: {
                userId,
                publishedModelId: grant.publishedModelId,
              },
            })),
          });
        }

        return {
          userId,
          created: createdGrants.length,
          skippedExisting: existingModelIds.size,
          grants,
        };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw grantAliasConflict('publishedModelIds');
      throw error;
    }
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

  private async requireProvider(
    id: string,
    client: Pick<Prisma.TransactionClient, 'providerConnection'> = this.prisma,
  ) {
    const provider = await client.providerConnection.findFirst({
      where: { id, deletedAt: null },
    });
    if (!provider) throw providerNotFound();
    return provider;
  }

  private async requireModel(
    id: string,
    client: Pick<Prisma.TransactionClient, 'publishedModel'> = this.prisma,
  ) {
    const model = await client.publishedModel.findFirst({
      where: { id, deletedAt: null, provider: { deletedAt: null } },
    });
    if (!model) throw modelNotFound();
    return model;
  }

  private async requireUser(
    id: string,
    client: Pick<Prisma.TransactionClient, 'user'> = this.prisma,
  ) {
    const user = await client.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw userNotFound();
    return user;
  }

  private async withSerializableTransaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isSerializationFailure(error) || attempt === maxAttempts) throw error;
      }
    }
    throw new AppError('internal_error', 500);
  }

  private audit(
    actor: AuthenticatedPrincipal,
    action: string,
    entityType: string,
    entityId: string,
    requestId: string,
    metadata?: Prisma.InputJsonObject,
    client: Pick<Prisma.TransactionClient, 'auditLog'> = this.prisma,
  ) {
    return client.auditLog.create({
      data: { actorUserId: actor.userId, action, entityType, entityId, requestId, metadata },
    });
  }
}

function providerNotFound(): AppError {
  return new AppError('invalid_request_error', 404, 'The provider was not found.', 'id');
}

function modelNotFound(): AppError {
  return new AppError('invalid_request_error', 404, 'The published model was not found.', 'id');
}

function batchModelsNotFound(): AppError {
  return new AppError(
    'invalid_request_error',
    404,
    'One or more published models were not found.',
    'publishedModelIds',
  );
}

function userNotFound(): AppError {
  return new AppError('invalid_request_error', 404, 'The user was not found.', 'userId');
}

function validateGrantAlias(alias: string, param: 'alias' | 'publishedModelIds'): string {
  if (alias.length > 255 || !grantAliasPattern.test(alias)) {
    throw new AppError(
      'invalid_request_error',
      400,
      param === 'alias'
        ? 'The model alias contains unsupported characters.'
        : 'An upstream model ID cannot be used as an alias. Grant that model separately with a valid user-specific name.',
      param,
    );
  }
  return alias;
}

function grantAliasConflict(param: 'alias' | 'publishedModelIds'): AppError {
  return new AppError(
    'invalid_request_error',
    409,
    param === 'alias'
      ? 'This model alias is already in use for this user.'
      : 'One or more model aliases are already in use for this user.',
    param,
  );
}

function deletedProviderName(originalName: string, id: string): string {
  return `${originalName} [deleted:${id}]`;
}

function deletedModelAlias(originalAlias: string, id: string): string {
  return `${originalAlias} [deleted:${id}]`;
}

function isForeignKeyConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2003'
  );
}

function isRecordNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2025'
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2034'
  );
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
