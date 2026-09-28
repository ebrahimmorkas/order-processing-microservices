import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { ZodError, type z } from 'zod';
import { AppError } from './errors.js';
import type { Logger } from './logger.js';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Standard Express setup shared by every service: security headers, JSON body
 * parsing, request-id propagation (for tracing a request across services) and
 * structured request logging.
 */
export function createBaseApp(logger: Logger, options: { json?: boolean } = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  // Proxies (the gateway) must stream bodies through untouched.
  if (options.json !== false) app.use(express.json({ limit: '100kb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: process.env.NODE_ENV !== 'test',
      genReqId: (req, res) => {
        const id = (req.headers[REQUEST_ID_HEADER] as string | undefined) ?? randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  return app;
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
  });
};

export const errorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (err, _req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
      return;
    }
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  };

/** Adds the 404 and error handlers; call after all routes are registered. */
export function finalizeApp(app: Express, logger: Logger): Express {
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}

export const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> =>
  schema.parse(value);
