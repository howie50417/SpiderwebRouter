import { beforeAll, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../src/config/runtime-config';
import { CryptoService } from '../src/security/crypto.service';
import {
  isPrivateAddress,
  isValidInternalProviderHostname,
} from '../src/gateway/safe-fetch.service';

beforeAll(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?schema=app';
  process.env.API_KEY_PEPPER = 'unit-test-api-key-pepper';
  process.env.PROVIDER_ENCRYPTION_KEY = 'unit-test-provider-encryption-key';
  loadRuntimeConfig({ refresh: true });
});

describe('secret protection and SSRF ranges', () => {
  it('encrypts provider secrets with authenticated encryption', () => {
    const crypto = new CryptoService();
    const encrypted = crypto.encryptSecret('provider-secret');
    expect(encrypted).not.toContain('provider-secret');
    expect(crypto.decryptSecret(encrypted)).toBe('provider-secret');
    expect(() => crypto.decryptSecret(`${encrypted.slice(0, -1)}x`)).toThrow();
  });

  it('hashes API keys without storing their raw value', () => {
    const crypto = new CryptoService();
    const hash = crypto.hashApiKey('sk-swr-example-key');
    expect(hash).not.toContain('sk-swr-example-key');
    expect(crypto.verifyApiKey('sk-swr-example-key', hash)).toBe(true);
    expect(crypto.verifyApiKey('different', hash)).toBe(false);
  });

  it('blocks private, loopback, link-local, and metadata-style addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.1.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('allows only Compose-style DNS labels in the HTTP provider allowlist', () => {
    expect(isValidInternalProviderHostname('ollama')).toBe(true);
    expect(isValidInternalProviderHostname('open-webui')).toBe(true);
    expect(isValidInternalProviderHostname('localhost')).toBe(false);
    expect(isValidInternalProviderHostname('127.0.0.1')).toBe(false);
    expect(isValidInternalProviderHostname('service.local')).toBe(false);
    expect(isValidInternalProviderHostname('internal.example.com')).toBe(false);
  });
});
