import { describe, expect, it, vi } from 'vitest';
import { SupabaseAuthAdmin } from './auth.js';

describe('SupabaseAuthAdmin', () => {
  it('aborts a timed-out deletion and classifies it as retryable without exposing a response', async () => {
    const timeout = Object.assign(new Error('secret upstream response'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(timeout);
    const admin = new SupabaseAuthAdmin(
      'https://example.supabase.co',
      'service-secret',
      250,
      fetchImpl,
    );

    await expect(admin.deleteUser('subject')).rejects.toMatchObject({
      code: 'AUTH_DELETE_TIMEOUT',
      retryable: true,
      message: '認証アカウントの削除がタイムアウトしました',
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats an already absent user as a successful idempotent deletion', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      new SupabaseAuthAdmin(
        'https://example.supabase.co',
        'service-secret',
        250,
        fetchImpl,
      ).deleteUser('subject'),
    ).resolves.toBeUndefined();
  });

  it('distinguishes transient server failures from permanent configuration errors', async () => {
    const transient = new SupabaseAuthAdmin(
      'https://example.supabase.co',
      'service-secret',
      250,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    );
    await expect(transient.deleteUser('subject')).rejects.toMatchObject({
      code: 'AUTH_DELETE_FAILED',
      retryable: true,
    });
    const permanent = new SupabaseAuthAdmin(
      'https://example.supabase.co',
      'service-secret',
      250,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
    );
    await expect(permanent.deleteUser('subject')).rejects.toMatchObject({
      code: 'AUTH_DELETE_FAILED',
      retryable: false,
    });
  });
});
