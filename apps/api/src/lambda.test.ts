import { describe, expect, it } from 'vitest';
import type { Context } from 'aws-lambda';
import { createApiLambdaHandler } from './lambda.js';

describe('API Lambda adapter', () => {
  it('serves the existing Express health route through API Gateway payload v2', async () => {
    const handler = createApiLambdaHandler({
      NODE_ENV: 'test',
      APP_MODE: 'fake',
      WEB_ORIGIN: 'http://localhost:3001',
      ALLOWED_EMAILS: 'developer@example.com',
    });
    const result = (await handler(
      {
        version: '2.0',
        routeKey: 'GET /health',
        rawPath: '/health',
        rawQueryString: '',
        headers: { host: 'api.example.test' },
        requestContext: {
          accountId: 'test',
          apiId: 'test',
          domainName: 'api.example.test',
          domainPrefix: 'api',
          http: {
            method: 'GET',
            path: '/health',
            protocol: 'HTTP/1.1',
            sourceIp: '127.0.0.1',
            userAgent: 'vitest',
          },
          requestId: 'request-id',
          routeKey: 'GET /health',
          stage: '$default',
          time: '01/Jan/2026:00:00:00 +0000',
          timeEpoch: 0,
        },
        isBase64Encoded: false,
      },
      {} as Context,
      () => undefined,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      data: { service: 'oshi-schedule-api', status: 'ok' },
    });
  });
});
