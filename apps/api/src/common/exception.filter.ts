import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { AppError, errorEnvelope } from './errors';
import { appLogger, safeLogObject } from './logger';

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const requestId = request.id || 'unknown';
    const appError = this.normalize(exception);

    appLogger.error(
      {
        request_id: requestId,
        method: request.method,
        path: request.url.split('?')[0],
        public_code: appError.code,
        err: appError.causeForLog instanceof Error ? appError.causeForLog : exception,
        details: safeLogObject(appError.causeForLog),
      },
      'request_failed',
    );

    if (reply.sent) return;
    reply.header('x-request-id', requestId);
    void reply.status(appError.statusCode).send(errorEnvelope(appError, requestId));
  }

  private normalize(exception: unknown): AppError {
    if (exception instanceof AppError) return exception;
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return new AppError(
          'invalid_request_error',
          409,
          'A record with the same unique value already exists.',
          null,
          exception,
        );
      }
      if (exception.code === 'P2025') {
        return new AppError(
          'invalid_request_error',
          404,
          'The requested record was not found.',
          null,
          exception,
        );
      }
      return new AppError('internal_error', 500, undefined, null, exception);
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 401)
        return new AppError('authentication_error', 401, undefined, null, exception);
      if (status === 403) return new AppError('permission_denied', 403, undefined, null, exception);
      if (status === 404)
        return new AppError(
          'invalid_request_error',
          404,
          'The requested resource was not found.',
          null,
          exception,
        );
      if (status >= 400 && status < 500) {
        return new AppError('invalid_request_error', status, undefined, null, exception);
      }
    }
    return new AppError('internal_error', 500, undefined, null, exception);
  }
}
