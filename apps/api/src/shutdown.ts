import type { Server } from 'node:http';
import type { Logger } from 'pino';

type ShutdownSignal = 'SIGTERM' | 'SIGINT';

export interface ShutdownControllerOptions {
  server: Pick<Server, 'close'> & Partial<Pick<Server, 'closeAllConnections'>>;
  disconnect: () => Promise<void>;
  timeoutMs: number;
  logger: Pick<Logger, 'info' | 'error'>;
  finish: (code: 0 | 1, forced: boolean) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export function createShutdownController(options: ShutdownControllerOptions) {
  let shuttingDown = false;

  return async (signal: ShutdownSignal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.logger.info({ signal }, 'api shutdown started');

    let timedOut = false;
    let closeError: Error | undefined;
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const closed = new Promise<void>((resolve) => {
      options.server.close((error?: Error) => {
        closeError = error;
        resolve();
      });
    });
    const timeout = new Promise<void>((resolve) => {
      timer = setTimer(() => {
        timedOut = true;
        resolve();
      }, options.timeoutMs);
      timer.unref?.();
    });

    await Promise.race([closed, timeout]);
    if (timer) clearTimer(timer);

    if (timedOut) {
      options.logger.error({ signal, timeoutMs: options.timeoutMs }, 'api shutdown timed out');
      options.server.closeAllConnections?.();
    }

    let disconnectFailed = false;
    try {
      await options.disconnect();
    } catch (error) {
      disconnectFailed = true;
      options.logger.error(
        { signal, errorName: error instanceof Error ? error.name : 'UnknownError' },
        'api resource disconnect failed',
      );
    }

    const failed = timedOut || Boolean(closeError) || disconnectFailed;
    if (closeError)
      options.logger.error({ signal, errorName: closeError.name }, 'api server close failed');
    if (!failed) options.logger.info({ signal }, 'api shutdown completed');
    options.finish(failed ? 1 : 0, timedOut);
  };
}
