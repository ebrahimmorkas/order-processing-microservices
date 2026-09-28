import { z } from 'zod';
import { createLogger, listen, loadConfig, onShutdown } from '@ops/common';
import { createGateway, SERVICE } from './gateway.js';

const config = loadConfig(
  z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    PORT: z.coerce.number().int().positive().default(8080),
    JWT_SECRET: z.string().min(32),
    CORS_ORIGIN: z.string().default('*'),
    AUTH_URL: z.string().default('http://localhost:4001'),
    ORDERS_URL: z.string().default('http://localhost:4002'),
    INVENTORY_URL: z.string().default('http://localhost:4003'),
    NOTIFICATIONS_URL: z.string().default('http://localhost:4004'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    PROXY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  }),
);

const logger = createLogger(SERVICE, config.LOG_LEVEL);
const app = createGateway({
  logger,
  jwtSecret: config.JWT_SECRET,
  corsOrigin: config.CORS_ORIGIN,
  proxyTimeoutMs: config.PROXY_TIMEOUT_MS,
  rateLimit: {
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
    authMax: config.AUTH_RATE_LIMIT_MAX,
  },
  upstreams: {
    auth: config.AUTH_URL,
    orders: config.ORDERS_URL,
    inventory: config.INVENTORY_URL,
    notifications: config.NOTIFICATIONS_URL,
  },
});

const server = await listen(app, config.PORT);
logger.info(`${SERVICE} listening on ${server.url}`);

onShutdown(logger, () => server.close());
