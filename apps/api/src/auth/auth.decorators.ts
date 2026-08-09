import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedPrincipal } from './auth.types';

export const REQUIRED_ROLES = Symbol('requiredRoles');
export const Roles = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES, roles);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { principal: AuthenticatedPrincipal }>();
    return request.principal;
  },
);
