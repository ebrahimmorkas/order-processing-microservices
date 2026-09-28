import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import cors from 'cors';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';
import {
  createBaseApp,
  finalizeApp,
  REQUEST_ID_HEADER,
  Unauthorized,
  USER_EMAIL_HEADER,
  USER_ID_HEADER,
  verifyToken,
  type Logger,
} from '@ops/common';

export const SERVICE = 'gateway';

export interface Upstreams {
  auth: string;
  orders: string;
  inventory: string;
  notifications: string;
}

export interface GatewayOptions {
  logger: Logger;
  jwtSecret: string;
  upstreams: Upstreams;
  corsOrigin?: string;
  rateLimit?: { windowMs: number; max: number; authMax: number };
  proxyTimeoutMs?: number;
}

/** Routes reachable without a token. Everything else requires a valid JWT. */
const PUBLIC_ROUTES: { method: string; pattern: RegExp }[] = [
  { method: 'POST', pattern: /^\/api\/auth\/(register|login)$/ },
  { method: 'GET', pattern: /^\/api\/products(\/.*)?$/ },
];

const isPublic = (method: string, path: string) =>
  PUBLIC_ROUTES.some((r) => r.method === method && r.pattern.test(path));

export function createGateway({
  logger,
  jwtSecret,
  upstreams,
  corsOrigin = '*',
  rateLimit: limits = { windowMs: 60_000, max: 300, authMax: 20 },
  proxyTimeoutMs = 10_000,
}: GatewayOptions) {
  const app = createBaseApp(logger, { json: false });
  app.use(cors({ origin: corsOrigin === '*' ? true : corsOrigin.split(',') }));

  const limiter = (max: number) =>
    rateLimit({
      windowMs: limits.windowMs,
      limit: max,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      },
    });

  /**
   * Authentication happens once, here. Downstream services receive a trusted
   * identity in headers; any client-supplied identity headers are stripped so
   * they can't be spoofed.
   */
  const authenticate: RequestHandler = (req, _res, next) => {
    delete req.headers[USER_ID_HEADER];
    delete req.headers[USER_EMAIL_HEADER];
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const user = verifyToken(header.slice('Bearer '.length), jwtSecret);
        req.headers[USER_ID_HEADER] = user.id;
        req.headers[USER_EMAIL_HEADER] = user.email;
        return next();
      } catch {
        throw Unauthorized('Invalid or expired token');
      }
    }
    if (isPublic(req.method, req.originalUrl.split('?')[0]!)) return next();
    throw Unauthorized('Missing bearer token');
  };

  /** Proxies `/api/<resource>/...` to `<upstream>/<resource>/...`. */
  const proxy = (resource: string, target: string, name: keyof Upstreams) =>
    createProxyMiddleware<IncomingMessage, ServerResponse>({
      target,
      pathFilter: `/api/${resource}`,
      pathRewrite: { '^/api': '' },
      changeOrigin: true,
      proxyTimeout: proxyTimeoutMs,
      on: {
        proxyReq: (proxyReq, req) => {
          // Propagate the request id so one request can be traced across services.
          const id = (req as IncomingMessage & { id?: string }).id;
          if (id) proxyReq.setHeader(REQUEST_ID_HEADER, id);
        },
        error: (err, _req, res) => {
          logger.warn({ err: err.message, upstream: name }, 'upstream unavailable');
          if (isServerResponse(res)) {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
            }
            res.end(
              JSON.stringify({
                error: { code: 'BAD_GATEWAY', message: `The ${name} service is unavailable` },
              }),
            );
          } else {
            (res as Socket).destroy();
          }
        },
      },
    });

  app.get('/health', async (_req, res) => {
    const entries = await Promise.all(
      (Object.entries(upstreams) as [keyof Upstreams, string][]).map(async ([name, url]) => {
        try {
          const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
          return [name, response.ok ? 'up' : 'down'] as const;
        } catch {
          return [name, 'down'] as const;
        }
      }),
    );
    const services = Object.fromEntries(entries);
    const healthy = entries.every(([, status]) => status === 'up');
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', services });
  });

  app.use('/api', limiter(limits.max));
  app.use('/api/auth', limiter(limits.authMax));
  app.use('/api', authenticate);

  app.use(proxy('auth', upstreams.auth, 'auth'));
  app.use(proxy('orders', upstreams.orders, 'orders'));
  app.use(proxy('products', upstreams.inventory, 'inventory'));
  app.use(proxy('notifications', upstreams.notifications, 'notifications'));

  finalizeApp(app, logger);
  return app;
}

const isServerResponse = (res: unknown): res is ServerResponse =>
  typeof (res as ServerResponse).writeHead === 'function';
