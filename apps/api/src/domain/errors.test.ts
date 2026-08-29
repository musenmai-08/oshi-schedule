import { describe, expect, it } from 'vitest';
import { AppError, classifyWorkerFailure } from './errors.js';

describe('worker failure classification', () => {
  it.each([
    ['credential decryption', 'TOKEN_DECRYPTION_FAILED', 'CREDENTIAL_DECRYPT'],
    ['Google auth', 'GOOGLE_RECONSENT_REQUIRED', 'GOOGLE_AUTH'],
    ['YouTube', 'YOUTUBE_API_ERROR', 'YOUTUBE'],
    ['Calendar', 'GOOGLE_EVENT_CREATE_FAILED', 'CALENDAR'],
  ] as const)('classifies %s AppError without its message', (_name, code, phase) => {
    const error = new AppError(code, 'secret-like error message must not be retained', 502);
    expect(classifyWorkerFailure(error, 'SYNC_EXECUTION')).toEqual({
      phase,
      errorCode: code,
      errorClass: 'APP_ERROR',
    });
  });

  it('uses a fixed database classification for Prisma errors', () => {
    const error = new Error('database-url-must-not-be-retained');
    error.name = 'PrismaClientInitializationError';
    expect(classifyWorkerFailure(error, 'SYNC_RUN_CLAIM')).toEqual({
      phase: 'DATABASE',
      errorCode: 'DATABASE_ERROR',
      errorClass: 'PRISMA_CLIENT_ERROR',
    });
  });

  it('does not expose unknown error text', () => {
    expect(
      classifyWorkerFailure(new Error('token-and-email-must-not-be-retained'), 'SYNC_RUN_CLAIM'),
    ).toEqual({
      phase: 'SYNC_RUN_CLAIM',
      errorCode: 'UNEXPECTED_ERROR',
      errorClass: 'UNKNOWN_ERROR',
    });
  });
});
