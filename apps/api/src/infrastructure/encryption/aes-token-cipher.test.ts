import { describe, expect, it } from 'vitest';
import { AesTokenCipher } from './aes-token-cipher.js';
describe('AesTokenCipher', () => {
  it('round trips without exposing plaintext', () => {
    const cipher = new AesTokenCipher(`v1:${Buffer.alloc(32, 7).toString('base64')}`);
    const result = cipher.encrypt('refresh-secret');
    expect(result.ciphertext).not.toContain('refresh-secret');
    expect(cipher.decrypt(result.ciphertext)).toBe('refresh-secret');
  });
});
