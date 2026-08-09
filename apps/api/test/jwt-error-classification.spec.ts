import { describe, expect, it } from 'vitest';
import { mapJwtVerificationError } from '../src/auth/keycloak-jwt.guard';

describe('Keycloak JWT verification error classification', () => {
  it.each([
    'ERR_JWT_EXPIRED',
    'ERR_JWT_CLAIM_VALIDATION_FAILED',
    'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    'ERR_JWT_INVALID',
    'ERR_JWKS_NO_MATCHING_KEY',
  ])('maps invalid token error %s to 401', (code) => {
    expect(
      mapJwtVerificationError(Object.assign(new Error('invalid token'), { code })),
    ).toMatchObject({ code: 'authentication_error', statusCode: 401 });
  });

  it('maps a remote JWKS timeout to a safe 504', () => {
    expect(
      mapJwtVerificationError(
        Object.assign(new Error('request timed out'), { code: 'ERR_JWKS_TIMEOUT' }),
      ),
    ).toMatchObject({ code: 'upstream_timeout', statusCode: 504 });
  });

  it.each([
    Object.assign(new Error('Expected 200 OK from JWKS'), { code: 'ERR_JOSE_GENERIC' }),
    Object.assign(new Error('malformed JWKS'), { code: 'ERR_JWKS_INVALID' }),
    new TypeError('fetch failed'),
  ])('maps a JWKS service failure to a safe 503 without logging the user out', (error) => {
    expect(mapJwtVerificationError(error)).toMatchObject({
      code: 'provider_unavailable',
      statusCode: 503,
    });
  });
});
