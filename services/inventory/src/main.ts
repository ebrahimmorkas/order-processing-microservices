import { z } from 'zod';
import {
  baseConfigSchema,
  booleanFromString,
  connectMongo,
  createEventBus,
  createLogger,
  listen,
  loadConfig,
  onShutdown,
} from '@ops/common';
import { createInventoryService, SERVICE } from './service.js';

const config = loadConfig(
  baseConfigSchema.extend({
    PORT: z.coerce.number().int().positive().default(4003),
    MONGO_URL: z.string().default('mongodb://localhost:27017/ops_inventory'),
    SEED_CATALOG: booleanFromString.default(true),
  }),
);

const logger = createLogger(SERVICE, config.LOG_LEVEL);
const connection = await connectMongo(config.MONGO_URL);
const bus = await createEventBus(config, logger);
const service = createInventoryService({
  connection,
  bus,
  logger,
  seedCatalog: config.SEED_CATALOG,
});
await service.start();
const server = await listen(service.app, config.PORT);
logger.info(`${SERVICE} service listening on ${server.url}`);

onShutdown(logger, async () => {
  await server.close();
  await service.stop();
  await bus.close();
  await connection.close();
});
