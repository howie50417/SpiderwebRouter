import { describe, expect, it } from 'vitest';
import { tokenTargetsClient } from '../src/auth/keycloak-jwt.guard';

describe('Keycloak client binding', () => {
  it('accepts the configured authorized party or audience', () => {
    expect(tokenTargetsClient({ azp: 'spiderwebrouter-web' }, 'spiderwebrouter-web')).toBe(true);
    expect(tokenTargetsClient({ aud: 'spiderwebrouter-web' }, 'spiderwebrouter-web')).toBe(true);
    expect(
      tokenTargetsClient({ aud: ['account', 'spiderwebrouter-web'] }, 'spiderwebrouter-web'),
    ).toBe(true);
  });

  it('rejects a valid realm token issued to another client', () => {
    expect(
      tokenTargetsClient({ azp: 'other-client', aud: ['account'] }, 'spiderwebrouter-web'),
    ).toBe(false);
  });
});
