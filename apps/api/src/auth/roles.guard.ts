import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import { AppError } from '../common/errors';
import { REQUIRED_ROLES } from './auth.decorators';
import type { AuthenticatedPrincipal } from './auth.types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(REQUIRED_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const request = context.switchToHttp().getRequest<{ principal?: AuthenticatedPrincipal }>();
    if (!request.principal || !required.includes(request.principal.role)) {
      throw new AppError('permission_denied', 403);
    }
    return true;
  }
}
