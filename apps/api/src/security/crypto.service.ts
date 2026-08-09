import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { loadRuntimeConfig } from '../config/runtime-config';

@Injectable()
export class CryptoService {
  private readonly config = loadRuntimeConfig();
  private readonly providerKey = this.keyBytes(this.config.providerEncryptionKey);

  hashApiKey(key: string): string {
    return createHmac('sha256', this.config.apiKeyPepper).update(key).digest('hex');
  }

  verifyApiKey(key: string, expectedHex: string): boolean {
    const actual = Buffer.from(this.hashApiKey(key), 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  encryptSecret(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.providerKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  decryptSecret(value: string | null): string | undefined {
    if (!value) return undefined;
    const [version, ivEncoded, tagEncoded, ciphertextEncoded] = value.split('.');
    if (version !== 'v1' || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
      throw new Error('Unsupported encrypted secret format');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.providerKey,
      Buffer.from(ivEncoded, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private keyBytes(value: string): Buffer {
    if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
    try {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length === 32) return decoded;
    } catch {
      // Fall through to deterministic derivation for legacy secrets.
    }
    return createHash('sha256').update(value).digest();
  }
}
