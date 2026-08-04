import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createShutdownController } from './shutdown.js';

function createServerDouble() {
  let closeCallback: ((error?: Error) => void) | undefined;
  const server = {
    close: vi.fn((callback?: (error?: Error) => void) => {
      closeCallback = callback;
      return server as unknown as Server;
    }),
    closeAllConnections: vi.fn(),
  };
  return { server, completeClose: (error?: Error) => closeCallback?.(error) };
}

const createLoggerDouble = () => ({ info: vi.fn(), error: vi.fn() });

describe('API shutdown controller', () => {
  it('stops accepting requests, disconnects resources and completes normally', async () => {
    const { server, completeClose } = createServerDouble();
    const disconnect = vi.fn(async () => undefined);
    const finish = vi.fn();
    const logger = createLoggerDouble();
    const shutdown = createShutdownController({
      server,
      disconnect,
      timeoutMs: 30_000,
      logger,
      finish,
    });

    const completion = shutdown('SIGTERM');
    expect(server.close).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    completeClose();
    await completion;

    expect(disconnect).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(0, false);
    expect(logger.info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'api shutdown completed');
  });

  it('does not run shutdown twice when multiple signals arrive', async () => {
    const { server, completeClose } = createServerDouble();
    const disconnect = vi.fn(async () => undefined);
    const finish = vi.fn();
    const shutdown = createShutdownController({
      server,
      disconnect,
      timeoutMs: 30_000,
      logger: createLoggerDouble(),
      finish,
    });

    const first = shutdown('SIGTERM');
    await shutdown('SIGINT');
    completeClose();
    await first;

    expect(server.close).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });

  it('forces connection closure and reports a non-zero timeout result', async () => {
    const { server } = createServerDouble();
    const disconnect = vi.fn(async () => undefined);
    const finish = vi.fn();
    const logger = createLoggerDouble();
    const shutdown = createShutdownController({
      server,
      disconnect,
      timeoutMs: 25,
      logger,
      finish,
      setTimer: ((callback: () => void) => {
        queueMicrotask(callback);
        return { unref: vi.fn() } as unknown as NodeJS.Timeout;
      }) as typeof setTimeout,
      clearTimer: vi.fn() as unknown as typeof clearTimeout,
    });

    await shutdown('SIGTERM');

    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(1, true);
    expect(logger.error).toHaveBeenCalledWith(
      { signal: 'SIGTERM', timeoutMs: 25 },
      'api shutdown timed out',
    );
  });

  it('reports disconnect failure without logging its message', async () => {
    const { server, completeClose } = createServerDouble();
    const finish = vi.fn();
    const logger = createLoggerDouble();
    const shutdown = createShutdownController({
      server,
      disconnect: async () => {
        throw new Error('must-not-be-logged');
      },
      timeoutMs: 30_000,
      logger,
      finish,
    });

    const completion = shutdown('SIGINT');
    completeClose();
    await completion;

    expect(finish).toHaveBeenCalledWith(1, false);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('must-not-be-logged');
  });
});
