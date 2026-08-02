import { describe, expect, it, vi } from 'vitest';
import { signOutSession } from './auth-actions';

describe('signOutSession', () => {
  it('uses the Supabase sign out result', async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    await expect(signOutSession(signOut)).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('replaces provider details with a safe message', async () => {
    const signOut = vi.fn(async () => ({ error: new Error('provider response details') }));
    await expect(signOutSession(signOut)).rejects.toThrow(
      'ログアウトできませんでした。もう一度お試しください。',
    );
  });
});
