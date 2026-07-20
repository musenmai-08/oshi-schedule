import { describe, expect, it } from 'vitest';
import { channelHandleSchema } from './index.js';

describe('channelHandleSchema', () => {
  it('accepts a YouTube handle', () =>
    expect(channelHandleSchema.parse(' @oshi_test ')).toBe('@oshi_test'));
  it('rejects a URL', () => expect(() => channelHandleSchema.parse('youtube.com/@oshi')).toThrow());
});
