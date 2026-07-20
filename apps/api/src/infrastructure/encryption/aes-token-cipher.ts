import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../../domain/errors.js';
import type { TokenCipher } from '../../application/models.js';

export class AesTokenCipher implements TokenCipher {
  private readonly keys: Map<string, Buffer>;
  private readonly primaryId: string;
  constructor(value: string) {
    const entries = value.split(',').map((item) => {
      const separator = item.indexOf(':');
      const id = item.slice(0, separator);
      const key = Buffer.from(item.slice(separator + 1), 'base64');
      if (!id || key.length !== 32)
        throw new Error('TOKEN_ENCRYPTION_KEYS must contain 32-byte base64 keys');
      return [id, key] as const;
    });
    const first = entries[0];
    if (!first) throw new Error('At least one encryption key is required');
    this.primaryId = first[0];
    this.keys = new Map(entries);
  }
  encrypt(plaintext: string) {
    const key = this.keys.get(this.primaryId);
    if (!key) throw new Error('Primary encryption key is missing');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      keyId: this.primaryId,
      ciphertext: [
        'v1',
        this.primaryId,
        iv.toString('base64url'),
        tag.toString('base64url'),
        encrypted.toString('base64url'),
      ].join('.'),
    };
  }
  decrypt(value: string) {
    const [version, keyId, ivValue, tagValue, encryptedValue] = value.split('.');
    if (version !== 'v1' || !keyId || !ivValue || !tagValue || !encryptedValue)
      throw new AppError('TOKEN_DECRYPTION_FAILED', '保存済み認証情報を利用できません', 500);
    const key = this.keys.get(keyId);
    if (!key) throw new AppError('TOKEN_KEY_NOT_FOUND', '保存済み認証情報を利用できません', 500);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
