import { describe, expect, it } from 'vitest';
import { sanitizeReturnTo } from '../src/auth/return-to';
import { type BrowserSession, sessionTtlSeconds } from '../src/auth/session.service';

describe('browser authentication policy', () => {
  it.each([
    ['/', '/'],
    ['/usage?status=FAILED#attempts', '/usage?status=FAILED#attempts'],
    ['/模型/清單', '/%E6%A8%A1%E5%9E%8B/%E6%B8%85%E5%96%AE'],
    ['https://evil.example/path', '/'],
    ['//evil.example/path', '/'],
    ['/\\evil.example/path', '/'],
    ['/%5c%5cevil.example/path', '/'],
    ['/%2f%2fevil.example/path', '/'],
    ['/%2e%2e//evil.example', '/'],
    ['/login?returnTo=/usage', '/'],
    ['/login%2Ffoo', '/'],
    ['/login/reset', '/'],
    ['/auth/logout', '/'],
    ['/safe\u0000path', '/'],
    ['/%00unsafe', '/'],
    ['not-a-path', '/'],
  ])('sanitizes returnTo %j', (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });

  it('uses the idle timeout while respecting refresh and absolute expiry', () => {
    const now = 1_000_000;
    const session: BrowserSession = {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: now + 300_000,
      refreshExpiresAt: now + 40 * 24 * 60 * 60 * 1000,
      absoluteExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
    };

    expect(sessionTtlSeconds(session, now, 604_800, 2_592_000)).toBe(604_800);
    expect(
      sessionTtlSeconds({ ...session, absoluteExpiresAt: now + 90_000 }, now, 604_800, 2_592_000),
    ).toBe(90);
  });

  it('does not keep a session without a refresh token past access expiry', () => {
    const now = 5_000_000;
    const session: BrowserSession = {
      accessToken: 'access',
      expiresAt: now + 240_000,
      absoluteExpiresAt: now + 2_592_000_000,
    };
    expect(sessionTtlSeconds(session, now, 604_800, 2_592_000)).toBe(240);
  });
});
