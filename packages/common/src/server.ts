import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { Logger } from './logger.js';

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/** Starts an HTTP server; port 0 picks a free port (used by tests). */
export function listen(app: Express, port: number): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({
        server,
        port: actual,
        url: `http://localhost:${actual}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Runs `cleanup` on SIGINT/SIGTERM, with a hard timeout. */
export function onShutdown(logger: Logger, cleanup: () => Promise<void>) {
  const handler = async (signal: string) => {
    logger.info({ signal }, 'shutting down gracefully');
    setTimeout(() => process.exit(1), 10_000).unref();
    try {
      await cleanup();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void handler('SIGINT'));
  process.once('SIGTERM', () => void handler('SIGTERM'));
}
