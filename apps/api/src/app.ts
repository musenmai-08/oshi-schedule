import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { Container } from './container.js';
import type { Env } from './infrastructure/env.js';
import { apiNotFound, authenticate, errorHandler, requestContext } from './presentation/http.js';
import { AppError } from './domain/errors.js';
import { createApiRouter } from './presentation/routes.js';

export function createApp(env: Env, container: Container): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext);
  app.use(
    helmet({
      // This service returns JSON, so a document CSP is intentionally owned by the Web app.
      contentSecurityPolicy: false,
      // TLS terminates at the deployment edge. Do not advertise HSTS from local HTTP.
      strictTransportSecurity: false,
    }),
  );
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
    }),
  );
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (_request, response) =>
    response.json({
      data: { status: 'ok', service: 'oshi-schedule-api' },
      requestId: response.locals.requestId,
    }),
  );
  app.use(
    '/api/v1',
    rateLimit({
      windowMs: 15 * 60_000,
      limit: env.NODE_ENV === 'test' ? 10_000 : 100,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_request, _response, next) =>
        next(
          new AppError(
            'RATE_LIMITED',
            'リクエストが多すぎます。時間を置いて再試行してください',
            429,
          ),
        ),
    }),
    authenticate(container),
    createApiRouter(container),
  );
  app.use(apiNotFound);
  app.use(errorHandler);
  return app;
}
