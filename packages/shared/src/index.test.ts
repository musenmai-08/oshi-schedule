import { describe, expect, it } from 'vitest';
import { channelHandleSchema, entityIdSchema } from './index.js';

describe('channelHandleSchema', () => {
  it('accepts a YouTube handle', () =>
    expect(channelHandleSchema.parse(' @oshi_test ')).toBe('@oshi_test'));
  it('rejects a URL', () => expect(() => channelHandleSchema.parse('youtube.com/@oshi')).toThrow());
});

describe('entityIdSchema', () => {
  it('accepts Prisma CUIDs and rejects UUIDs or malformed values', () => {
    expect(entityIdSchema.safeParse('cm0wz73bk0000qzrmn831i7rn').success).toBe(true);
    expect(entityIdSchema.safeParse('d6ba9e4d-e391-4290-93e7-6fe43dfff917').success).toBe(false);
    expect(entityIdSchema.safeParse('../invalid').success).toBe(false);
  });
});
