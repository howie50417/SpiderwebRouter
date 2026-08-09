import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from '../src/config/runtime-config';
import { CryptoService } from '../src/security/crypto.service';
import { isPrivateAddress, SafeFetchService } from '../src/gateway/safe-fetch.service';

beforeAll(() => {
  vi.stubEnv('API_KEY_PEPPER', 'unit-test-api-key-pepper');
  vi.stubEnv('PROVIDER_ENCRYPTION_KEY', '11'.repeat(32));
  vi.stubEnv('ALLOWED_HTTP_HOSTS', 'ollama,open-webui');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test?schema=app');
  loadRuntimeConfig({ refresh: true });
});

describe('API key HMAC and provider encryption', () => {
  it('uses a peppered HMAC and constant-time-compatible verification', () => {
    const crypto = new CryptoService();
    const key = 'sk-swr-unit-test-key';
    const expected = createHmac('sha256', 'unit-test-api-key-pepper').update(key).digest('hex');

    expect(crypto.hashApiKey(key)).toBe(expected);
    expect(crypto.verifyApiKey(key, expected)).toBe(true);
    expect(crypto.verifyApiKey('sk-swr-wrong-key', expected)).toBe(false);
    expect(crypto.verifyApiKey(key, 'not-a-valid-hex-digest')).toBe(false);
  });

  it('round-trips AES-256-GCM secrets with randomized ciphertext', () => {
    const crypto = new CryptoService();
    const first = crypto.encryptSecret('provider bearer credential');
    const second = crypto.encryptSecret('provider bearer credential');

    expect(first).not.toBe(second);
    expect(first).not.toContain('provider bearer credential');
    expect(crypto.decryptSecret(first)).toBe('provider bearer credential');
    expect(crypto.decryptSecret(second)).toBe('provider bearer credential');
  });

  it('rejects tampered encrypted provider secrets', () => {
    const crypto = new CryptoService();
    const encrypted = crypto.encryptSecret('credential');
    const [version, iv, tag, ciphertext] = encrypted.split('.');
    const tamperedBytes = Buffer.from(ciphertext!, 'base64url');
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0x01;
    const tampered = [version, iv, tag, tamperedBytes.toString('base64url')].join('.');

    expect(() => crypto.decryptSecret(tampered)).toThrow();
  });
});

describe('SSRF address classification', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a00:1',
    '::ffff:a9fe:a9fe',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    '2001:db8::1',
    'malformed-address',
  ])('blocks private, local, reserved or malformed address %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])(
    'allows public address %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it('blocks credentials, fragments, localhost and unapproved plain HTTP before fetching', async () => {
    const safeFetch = new SafeFetchService();

    await expect(
      safeFetch.assertSafeDestination(new URL('https://user:password@example.com/v1')),
    ).rejects.toMatchObject({ category: 'security' });
    await expect(
      safeFetch.assertSafeDestination(new URL('https://example.com/v1#fragment')),
    ).rejects.toMatchObject({ category: 'security' });
    await expect(
      safeFetch.assertSafeDestination(new URL('https://localhost/v1')),
    ).rejects.toMatchObject({ category: 'security' });
    await expect(
      safeFetch.assertSafeDestination(new URL('http://example.com/v1')),
    ).rejects.toMatchObject({ category: 'security' });
  });

  it('permits plain HTTP only for explicitly allowlisted Compose hostnames', async () => {
    const safeFetch = new SafeFetchService();

    await expect(
      safeFetch.assertSafeDestination(new URL('http://ollama:11434/api/chat')),
    ).resolves.toBeUndefined();
  });
});
