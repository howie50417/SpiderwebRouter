import pino from 'pino';

const redactionPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.authorization',
  '*.apiKey',
  '*.secret',
  '*.token',
  'body',
  'request.body',
  'prompt',
  'messages',
  'input',
  'images',
  'tool_arguments',
];

export const appLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined,
  redact: { paths: redactionPaths, censor: '[REDACTED]' },
  serializers: {
    err(error: unknown) {
      if (!(error instanceof Error)) return { type: typeof error };
      return {
        type: error.name,
        message: redactText(error.message),
        stack: redactText(error.stack ?? ''),
      };
    },
  },
});

const SECRET_PATTERN =
  /(authorization|api[-_ ]?key|token|secret|cookie|bearer)(\s*[=:]\s*|\s+)[^\s,;"']+/gi;
const KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{16,})\b/g;
const BEARER_PATTERN = /\bBearer\s+[^\s,;"']+/gi;
const JSON_SECRET_PATTERN =
  /("(?:authorization|api[-_ ]?key|token|secret|cookie|prompt|messages|input|output|images|tool_arguments)"\s*:\s*)"(?:\\.|[^"\\])*"/gi;

export function redactText(value: string, maxLength = 16 * 1024): string {
  let candidate = value;
  try {
    candidate = JSON.stringify(sanitizeLogValue(JSON.parse(value) as unknown));
  } catch {
    // Non-JSON diagnostics are scrubbed with conservative text patterns below.
  }
  const redacted = candidate
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SECRET_PATTERN, '$1$2[REDACTED]')
    .replace(JSON_SECRET_PATTERN, '$1"[REDACTED]"')
    .replace(KEY_PATTERN, '[REDACTED]');
  return truncateUtf8(redacted, maxLength);
}

export function safeLogObject(value: unknown): unknown {
  return sanitizeLogValue(value);
}

function sanitizeLogValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateUtf8(redactScalarText(value), 16 * 1024);
  if (Array.isArray(value)) return value.slice(0, 100).map(sanitizeLogValue);
  if (typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      /authorization|cookie|secret|api.?key|token|prompt|message|input|output|image|tool/i.test(key)
    ) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeLogValue(child);
    }
  }
  return result;
}

function redactScalarText(value: string): string {
  return value
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SECRET_PATTERN, '$1$2[REDACTED]')
    .replace(JSON_SECRET_PATTERN, '$1"[REDACTED]"')
    .replace(KEY_PATTERN, '[REDACTED]');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  return bytes
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}

export const fastifyLoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: redactionPaths, censor: '[REDACTED]' },
};
