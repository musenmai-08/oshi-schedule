import { describe, expect, it } from 'vitest';
import { AesTokenCipher } from './aes-token-cipher.js';
describe('AesTokenCipher', () => {
  it('round trips without exposing plaintext', () => {
    const cipher = new AesTokenCipher(`v1:${Buffer.alloc(32, 7).toString('base64')}`);
    const result = cipher.encrypt('refresh-secret');
    expect(result.ciphertext).not.toContain('refresh-secret');
    expect(cipher.decrypt(result.ciphertext)).toBe('refresh-secret');
  });

  it('rejects duplicate key identifiers instead of silently shadowing a rotation key', () => {
    const first = Buffer.alloc(32, 1).toString('base64');
    const second = Buffer.alloc(32, 2).toString('base64');
    expect(() => new AesTokenCipher(`v1:${first},v1:${second}`)).toThrow(/duplicate/i);
  });
});
