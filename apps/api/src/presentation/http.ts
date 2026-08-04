import type { NextFunction, Request, Response } from 'express';
import type { AuthIdentity } from '../application/models.js';
import type { Container } from '../container.js';
import { AppError } from '../domain/errors.js';
import { logger } from '../infrastructure/logging/logger.js';

declare global {
  // Express exposes request-scoped locals through declaration merging.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      identity: AuthIdentity;
      requestId: string;
    }
  }
}

export const requestContext = (request: Request, response: Response, next: NextFunction) => {
  const incoming = request.header('x-request-id');
  response.locals.requestId =
    incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  response.setHeader('x-request-id', response.locals.requestId);
  next();
};

export const authenticate =
  (container: Container) => async (request: Request, response: Response, next: NextFunction) => {
    try {
      const value = request.header('authorization');
      if (!value?.startsWith('Bearer '))
        throw new AppError('UNAUTHORIZED', 'ログインが必要です', 401);
      const identity = await container.auth.verify(value.slice(7));
      if (!container.invitation.allows(identity.email))
        throw new AppError('NOT_INVITED', 'このメールアドレスは招待されていません', 403);
      response.locals.identity = identity;
      next();
    } catch (error) {
      next(error);
    }
  };

export const success = <T>(response: Response, data: T, status = 200) =>
  response.status(status).json({ data, requestId: response.locals.requestId });
export const asyncRoute =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };

type ExpressBodyError = Error & { status?: number; type?: string };

const normalizeHttpError = (error: unknown) => {
  if (error instanceof AppError) return error;
  const bodyError = error as ExpressBodyError;
  if (bodyError?.type === 'entity.too.large' || bodyError?.status === 413)
    return new AppError('PAYLOAD_TOO_LARGE', 'リクエスト本文が大きすぎます', 413);
  if (
    bodyError?.type === 'entity.parse.failed' ||
    (error instanceof SyntaxError && bodyError.status === 400)
  )
    return new AppError('INVALID_JSON', 'JSONの形式が正しくありません', 400);
  return new AppError('INTERNAL_ERROR', '処理に失敗しました', 500);
};

export const apiNotFound = (_request: Request, _response: Response, next: NextFunction) =>
  next(new AppError('NOT_FOUND', '指定されたAPIは存在しません', 404));

export const errorHandler = (
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
) => {
  void next;
  const appError = normalizeHttpError(error);
  const logData = {
    requestId: response.locals.requestId,
    errorCode: appError.code,
    errorName: error instanceof Error ? error.name : 'unknown',
    status: appError.status,
  };
  if (appError.status >= 500) logger.error(logData, 'request failed');
  else if ([400, 401, 403, 404].includes(appError.status)) logger.info(logData, 'request rejected');
  else logger.warn(logData, 'request rejected');
  response.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
    },
    requestId: response.locals.requestId,
  });
};
