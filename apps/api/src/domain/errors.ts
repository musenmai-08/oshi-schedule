export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = () => new AppError('NOT_FOUND', '対象が見つかりません', 404);

export class StoreConstraintError extends Error {
  constructor(public readonly reason: 'CHANNEL_LIMIT' | 'DUPLICATE_CHANNEL') {
    super(reason);
    this.name = 'StoreConstraintError';
  }
}
