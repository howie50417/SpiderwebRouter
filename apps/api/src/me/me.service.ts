import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { AppError } from '../common/errors';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { UsageQueryService, type UsageHttpQuery } from '../usage/usage-query.service';

const createKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiresAt: z.string().datetime().optional().nullable(),
});

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly usageQuery: UsageQueryService,
  ) {}

  profile(principal: AuthenticatedPrincipal) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        active: true,
        createdAt: true,
      },
    });
  }

  models(principal: AuthenticatedPrincipal) {
    return this.prisma.userModelGrant
      .findMany({
        where: {
          userId: principal.userId,
          active: true,
          publishedModel: { active: true, provider: { active: true } },
        },
        select: {
          id: true,
          alias: true,
          customInputPricePerM: true,
          customOutputPricePerM: true,
          publishedModel: {
            select: {
              displayName: true,
              capabilities: true,
              inputPricePerM: true,
              outputPricePerM: true,
            },
          },
        },
        orderBy: { alias: 'asc' },
      })
      .then((items) =>
        items.map((item) => ({
          id: item.id,
          alias: item.alias,
          displayName: item.publishedModel.displayName ?? item.alias,
          capabilities: item.publishedModel.capabilities,
          inputPricePerM: item.customInputPricePerM ?? item.publishedModel.inputPricePerM,
          outputPricePerM: item.customOutputPricePerM ?? item.publishedModel.outputPricePerM,
        })),
      );
  }

  listApiKeys(principal: AuthenticatedPrincipal) {
    return this.prisma.apiKey.findMany({
      where: { userId: principal.userId },
      select: {
        id: true,
        name: true,
        prefix: true,
        lastFour: true,
        active: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createApiKey(principal: AuthenticatedPrincipal, input: unknown, requestId: string) {
    const parsed = createKeySchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new AppError(
        'invalid_request_error',
        400,
        issue?.message,
        issue?.path.join('.') || null,
      );
    }
    const rawKey = `sk-swr-${randomBytes(32).toString('base64url')}`;
    const record = await this.prisma.apiKey.create({
      data: {
        userId: principal.userId,
        name: parsed.data.name,
        keyHash: this.crypto.hashApiKey(rawKey),
        prefix: rawKey.slice(0, 14),
        lastFour: rawKey.slice(-4),
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      },
      select: {
        id: true,
        name: true,
        prefix: true,
        lastFour: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: principal.userId,
        action: 'api_key.create',
        entityType: 'ApiKey',
        entityId: record.id,
        requestId,
        metadata: { name: record.name, prefix: record.prefix, lastFour: record.lastFour },
      },
    });
    return { ...record, key: rawKey };
  }

  async revokeApiKey(principal: AuthenticatedPrincipal, id: string, requestId: string) {
    const key = await this.prisma.apiKey.findFirst({
      where: { id, userId: principal.userId, revokedAt: null },
      select: { id: true, name: true, prefix: true, lastFour: true },
    });
    if (!key) throw new AppError('invalid_request_error', 404, 'The API key was not found.');
    const result = await this.prisma.apiKey.updateMany({
      where: { id, userId: principal.userId, revokedAt: null },
      data: { active: false, revokedAt: new Date() },
    });
    if (!result.count)
      throw new AppError('invalid_request_error', 404, 'The API key was not found.');
    await this.prisma.auditLog.create({
      data: {
        actorUserId: principal.userId,
        action: 'api_key.revoke',
        entityType: 'ApiKey',
        entityId: id,
        requestId,
        metadata: { name: key.name, prefix: key.prefix, lastFour: key.lastFour },
      },
    });
    return { id, revoked: true };
  }

  usage(principal: AuthenticatedPrincipal, query: UsageHttpQuery = {}) {
    return this.usageQuery.query(query, principal.userId);
  }

  usageCsv(principal: AuthenticatedPrincipal, query: UsageHttpQuery = {}) {
    return this.usageQuery.exportCsv(query, principal.userId);
  }
}
