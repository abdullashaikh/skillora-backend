import { describe, it, expect, beforeAll } from 'vitest';
import { encryptSecret, decryptSecret, maskApiKey } from '../lib/security/crypto';

describe('Security & Cryptography Module', () => {
  beforeAll(() => {
    // 32 bytes hex = 64 characters
    process.env.APP_ENCRYPTION_KEY =
      '35d86c0238b81e597d6382b0e5515cb40de4be948824d1e2d38da25f57cd6491';
  });

  it('should encrypt and decrypt a plaintext secret accurately using AES-256-GCM', () => {
    const rawSecret = 'sk-proj-supersecretkey1234567890abcdefghijklmnopqrstuvwxyz';
    const encrypted = encryptSecret(rawSecret);

    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toHaveLength(24); // 12 bytes = 24 hex characters
    expect(encrypted.authTag).toHaveLength(32); // 16 bytes = 32 hex characters

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(rawSecret);
  });

  it('should generate a unique IV for every encryption call', () => {
    const rawSecret = 'AIzaSyExampleKey1234567890';
    const enc1 = encryptSecret(rawSecret);
    const enc2 = encryptSecret(rawSecret);

    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);

    expect(decryptSecret(enc1)).toBe(rawSecret);
    expect(decryptSecret(enc2)).toBe(rawSecret);
  });

  it('should fail decryption if ciphertext or authTag is tampered with', () => {
    const encrypted = encryptSecret('test-secret');
    const tamperedPayload = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.slice(0, -2) + 'ff',
    };

    expect(() => decryptSecret(tamperedPayload)).toThrow();
  });

  it('should safely mask credentials for admin presentation without revealing the full key', () => {
    expect(maskApiKey('sk-proj-1234567890abcdef')).toBe('sk-••••••••cdef');
    expect(maskApiKey('AIzaSyD1234567890XYZ1234')).toBe('AIza••••••••1234');
    expect(maskApiKey('short')).toBe('••••••••');
  });
});
