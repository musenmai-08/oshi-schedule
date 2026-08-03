import { pino, type DestinationStream, type LoggerOptions } from 'pino';
import { sanitizeLogArguments } from './sanitize-log-data.js';

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  hooks: {
    logMethod(arguments_, method) {
      method.apply(this, sanitizeLogArguments(arguments_) as Parameters<typeof method>);
    },
  },
  redact: {
    paths: [
      'req.headers.authorization',
      '*.providerRefreshToken',
      '*.providerAccessToken',
      '*.email',
      '*.encryptedRefreshToken',
    ],
    censor: '[REDACTED]',
  },
};

export const createLogger = (destination?: DestinationStream) =>
  destination ? pino(options, destination) : pino(options);

export const logger = createLogger();
