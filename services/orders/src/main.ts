import { z } from 'zod';
import {
  baseConfigSchema,
  connectMongo,
  createEventBus,
  createLogger,
  listen,
  loadConfig,
  onShutdown,
} from '@ops/common';
import { createOrdersService, SERVICE } from './service.js';

const config = loadConfig(
  baseConfigSchema.extend({
    PORT: z.coerce.number().int().positive().default(4002),
    MONGO_URL: z.string().default('mongodb://localhost:27017/ops_orders'),
  }),
);

const logger = createLogger(SERVICE, config.LOG_LEVEL);
const connection = await connectMongo(config.MONGO_URL);
const bus = await createEventBus(config, logger);
const service = createOrdersService({ connection, bus, logger });
await service.start();
const server = await listen(service.app, config.PORT);
logger.info(`${SERVICE} service listening on ${server.url}`);

onShutdown(logger, async () => {
  await server.close();
  await service.stop();
  await bus.close();
  await connection.close();
});
