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

export const errorHandler = (
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
) => {
  void next;
  const appError =
    error instanceof AppError ? error : new AppError('INTERNAL_ERROR', '処理に失敗しました', 500);
  logger.error(
    {
      requestId: response.locals.requestId,
      code: appError.code,
      errorName: error instanceof Error ? error.name : 'unknown',
    },
    'request failed',
  );
  response.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
    },
    requestId: response.locals.requestId,
  });
};
