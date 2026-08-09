export type PublicErrorCode =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_denied'
  | 'model_not_found'
  | 'unsupported_feature'
  | 'rate_limit_error'
  | 'provider_unavailable'
  | 'upstream_timeout'
  | 'internal_error';

const DEFAULT_MESSAGES: Record<PublicErrorCode, string> = {
  invalid_request_error: 'The request is invalid.',
  authentication_error: 'Invalid authentication credentials.',
  permission_denied: 'You do not have permission to perform this action.',
  model_not_found: 'The requested model does not exist or you do not have access to it.',
  unsupported_feature: 'The requested feature is not supported by this model.',
  rate_limit_error: 'The service is temporarily busy. Please try again later.',
  provider_unavailable: 'The model service is temporarily unavailable.',
  upstream_timeout: 'The model service timed out.',
  internal_error: 'An internal error occurred.',
};

export class AppError extends Error {
  constructor(
    public readonly code: PublicErrorCode,
    public readonly statusCode: number,
    message = DEFAULT_MESSAGES[code],
    public readonly param: string | null = null,
    public readonly causeForLog?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function publicErrorType(code: PublicErrorCode): string {
  if (code === 'authentication_error') return 'authentication_error';
  if (code === 'permission_denied') return 'permission_error';
  if (code === 'rate_limit_error') return 'rate_limit_error';
  if (code === 'internal_error') return 'server_error';
  return 'invalid_request_error';
}

export function defaultPublicMessage(code: PublicErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

export interface PublicErrorEnvelope {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: PublicErrorCode;
    request_id: string;
  };
}

export function errorEnvelope(error: AppError, requestId: string): PublicErrorEnvelope {
  return {
    error: {
      message: error.message,
      type: publicErrorType(error.code),
      param: error.param,
      code: error.code,
      request_id: requestId,
    },
  };
}
