import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError } from '../../domain/errors.js';
import type { AuthAdmin, AuthIdentity, AuthVerifier } from '../../application/models.js';

export class FakeAuthVerifier implements AuthVerifier {
  async verify(token: string): Promise<AuthIdentity> {
    if (token === 'demo-token') return { subject: 'demo-user', email: 'developer@example.com' };
    const match = /^test:([^:]+):(.+@.+)$/.exec(token);
    if (match?.[1] && match[2]) return { subject: match[1], email: match[2] };
    throw new AppError('UNAUTHORIZED', 'ログインが必要です', 401);
  }
}
export class SupabaseAuthVerifier implements AuthVerifier {
  private readonly jwks;
  constructor(
    private readonly url: string,
    private readonly audience: string,
  ) {
    this.jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  }
  async verify(token: string) {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: `${this.url}/auth/v1`,
        audience: this.audience,
      });
      if (!payload.sub || typeof payload.email !== 'string') throw new Error('claims');
      return { subject: payload.sub, email: payload.email };
    } catch {
      throw new AppError('UNAUTHORIZED', 'ログインが必要です', 401);
    }
  }
}
export class FakeAuthAdmin implements AuthAdmin {
  async deleteUser() {}
}
export class SupabaseAuthAdmin implements AuthAdmin {
  constructor(
    private readonly url: string,
    private readonly serviceRoleKey: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async deleteUser(subject: string) {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.url}/auth/v1/admin/users/${encodeURIComponent(subject)}`,
        {
          method: 'DELETE',
          headers: { apikey: this.serviceRoleKey, authorization: `Bearer ${this.serviceRoleKey}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new AppError(
        timedOut ? 'AUTH_DELETE_TIMEOUT' : 'AUTH_DELETE_UNAVAILABLE',
        timedOut ? '認証アカウントの削除がタイムアウトしました' : '認証サービスへ接続できません',
        502,
        true,
      );
    }
    if (!response.ok && response.status !== 404)
      throw new AppError(
        'AUTH_DELETE_FAILED',
        '認証アカウントを削除できません',
        502,
        response.status >= 500,
      );
  }
}
