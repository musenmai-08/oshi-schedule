export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export type WorkerFailurePhase =
  | 'INITIALIZATION'
  | 'SYNC_RUN_CLAIM'
  | 'DATABASE'
  | 'CREDENTIAL_DECRYPT'
  | 'GOOGLE_AUTH'
  | 'YOUTUBE'
  | 'CALENDAR'
  | 'SYNC_EXECUTION'
  | 'SHUTDOWN';

export interface SafeWorkerFailure {
  phase: WorkerFailurePhase;
  errorCode: string;
  errorClass: 'APP_ERROR' | 'PRISMA_CLIENT_ERROR' | 'UNKNOWN_ERROR';
}

const safeAppErrorCode = (code: string) =>
  /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'APPLICATION_ERROR';

const isPrismaClientError = (error: unknown) =>
  error instanceof Error &&
  /^(PrismaClientKnownRequestError|PrismaClientUnknownRequestError|PrismaClientValidationError|PrismaClientInitializationError|PrismaClientRustPanicError)$/.test(
    error.name,
  );

export function classifyWorkerFailure(
  error: unknown,
  fallbackPhase: WorkerFailurePhase,
): SafeWorkerFailure {
  if (error instanceof AppError) {
    const errorCode = safeAppErrorCode(error.code);
    if (errorCode === 'TOKEN_DECRYPTION_FAILED' || errorCode === 'TOKEN_KEY_NOT_FOUND')
      return { phase: 'CREDENTIAL_DECRYPT', errorCode, errorClass: 'APP_ERROR' };
    if (/^GOOGLE_(TOKEN|REAUTH|RECONSENT)/.test(errorCode))
      return { phase: 'GOOGLE_AUTH', errorCode, errorClass: 'APP_ERROR' };
    if (/^GOOGLE_(CALENDAR|EVENT)_/.test(errorCode))
      return { phase: 'CALENDAR', errorCode, errorClass: 'APP_ERROR' };
    if (/^YOUTUBE_/.test(errorCode))
      return { phase: 'YOUTUBE', errorCode, errorClass: 'APP_ERROR' };
    return { phase: fallbackPhase, errorCode, errorClass: 'APP_ERROR' };
  }
  if (isPrismaClientError(error))
    return { phase: 'DATABASE', errorCode: 'DATABASE_ERROR', errorClass: 'PRISMA_CLIENT_ERROR' };
  return { phase: fallbackPhase, errorCode: 'UNEXPECTED_ERROR', errorClass: 'UNKNOWN_ERROR' };
}

export class WorkerExecutionError extends Error {
  readonly failure: SafeWorkerFailure;

  constructor(fallbackPhase: WorkerFailurePhase, error: unknown) {
    // Keep the existing in-process error contract for callers. The Worker log
    // intentionally emits only `failure`, never this message.
    super(error instanceof Error ? error.message : 'Worker execution failed');
    this.name = 'WorkerExecutionError';
    this.failure = classifyWorkerFailure(error, fallbackPhase);
  }
}

export const notFound = () => new AppError('NOT_FOUND', '対象が見つかりません', 404);

export class StoreConstraintError extends Error {
  constructor(
    public readonly reason:
      'CHANNEL_LIMIT' | 'DUPLICATE_CHANNEL' | 'SUBSCRIPTION_NOT_FOUND' | 'SYNC_COOLDOWN',
  ) {
    super(reason);
    this.name = 'StoreConstraintError';
  }
}
