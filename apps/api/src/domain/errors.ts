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
