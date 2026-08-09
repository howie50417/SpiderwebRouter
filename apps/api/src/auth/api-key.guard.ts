import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { AppError } from '../common/errors';
import type { AuthenticatedPrincipal } from './auth.types';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { principal?: AuthenticatedPrincipal }>();
    const header = request.headers.authorization;
    const match =
      typeof header === 'string'
        ? /^Bearer\s+(sk-swr-[A-Za-z0-9_-]{24,})$/i.exec(header.trim())
        : null;
    if (!match?.[1]) throw new AppError('authentication_error', 401);
    const rawKey = match[1];
    const keyHash = this.crypto.hashApiKey(rawKey);
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: { user: true },
    });
    if (
      !apiKey ||
      !apiKey.active ||
      apiKey.revokedAt ||
      (apiKey.expiresAt && apiKey.expiresAt <= new Date()) ||
      !apiKey.user.active ||
      !this.crypto.verifyApiKey(rawKey, apiKey.keyHash)
    ) {
      throw new AppError('authentication_error', 401);
    }
    request.principal = {
      userId: apiKey.userId,
      subject: apiKey.user.keycloakSubject ?? apiKey.userId,
      email: apiKey.user.email,
      role: apiKey.user.role,
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
    };
    await this.prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
    return true;
  }
}
