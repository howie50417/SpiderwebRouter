import { describe, expect, it } from 'vitest';

import { consoleLoginHref, sanitizeReturnTo } from '@/auth/returnTo';

describe('returnTo safety', () => {
  it.each([
    ['/', '/'],
    ['/usage?status=FAILED#attempts', '/usage?status=FAILED#attempts'],
    ['https://evil.example/path', '/'],
    ['//evil.example/path', '/'],
    ['/\\evil.example/path', '/'],
    ['/%5c%5cevil.example/path', '/'],
    ['/%2f%2fevil.example/path', '/'],
    ['/%2e%2e//evil.example', '/'],
    ['/login?returnTo=/usage', '/'],
    ['/login%2Ffoo', '/'],
    ['/auth/logout', '/'],
    ['/%00unsafe', '/'],
  ])('sanitizes %j', (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });

  it('builds an expired-login URL with the complete internal location', () => {
    expect(consoleLoginHref('/usage?status=FAILED#attempts', true)).toBe(
      '/login?returnTo=%2Fusage%3Fstatus%3DFAILED%23attempts&reason=expired',
    );
  });
});
