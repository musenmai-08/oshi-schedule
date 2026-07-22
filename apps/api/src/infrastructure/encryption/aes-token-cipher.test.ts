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

  it('uses a fresh IV and authenticates ciphertext changes', () => {
    const cipher = new AesTokenCipher(`v1:${Buffer.alloc(32, 7).toString('base64')}`);
    const first = cipher.encrypt('refresh-secret').ciphertext;
    const second = cipher.encrypt('refresh-secret').ciphertext;
    expect(first.split('.')[2]).not.toBe(second.split('.')[2]);
    const parts = first.split('.');
    parts[4] = `${parts[4]?.startsWith('A') ? 'B' : 'A'}${parts[4]?.slice(1)}`;
    expect(() => cipher.decrypt(parts.join('.'))).toThrow();
  });

  it('decrypts an old key while using the first configured key for new encryption', () => {
    const oldKey = Buffer.alloc(32, 7).toString('base64');
    const newKey = Buffer.alloc(32, 8).toString('base64');
    const oldCiphertext = new AesTokenCipher(`old:${oldKey}`).encrypt('refresh-secret').ciphertext;
    const rotating = new AesTokenCipher(`new:${newKey},old:${oldKey}`);
    expect(rotating.decrypt(oldCiphertext)).toBe('refresh-secret');
    const reencrypted = rotating.encrypt(rotating.decrypt(oldCiphertext));
    expect(reencrypted.keyId).toBe('new');
    expect(rotating.decrypt(reencrypted.ciphertext)).toBe('refresh-secret');
  });

  it('fails safely for an unknown key version', () => {
    const cipher = new AesTokenCipher(`v1:${Buffer.alloc(32, 7).toString('base64')}`);
    const parts = cipher.encrypt('refresh-secret').ciphertext.split('.');
    parts[1] = 'retired';
    expect(() => cipher.decrypt(parts.join('.'))).toThrow(/保存済み認証情報/);
  });

  it('fails authentication when the key id exists but the key is wrong', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const ciphertext = new AesTokenCipher(`v1:${key}`).encrypt('refresh-secret').ciphertext;
    const wrong = new AesTokenCipher(`v1:${Buffer.alloc(32, 8).toString('base64')}`);
    expect(() => wrong.decrypt(ciphertext)).toThrow();
  });

  it('rejects malformed base64 key material', () => {
    expect(() => new AesTokenCipher(`v1:${'!'.repeat(44)}`)).toThrow(/base64/i);
  });
});
