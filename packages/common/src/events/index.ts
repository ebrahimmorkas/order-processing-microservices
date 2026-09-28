import type { Logger } from '../logger.js';
import { MongoEventBus, type MongoEventBusOptions } from './mongo-event-bus.js';
import { RabbitMqEventBus, type RabbitMqEventBusOptions } from './rabbitmq-event-bus.js';
import type { EventBus } from './types.js';

export * from './types.js';
export { MongoEventBus } from './mongo-event-bus.js';
export { RabbitMqEventBus } from './rabbitmq-event-bus.js';
export { idempotent } from './inbox.js';

export interface EventBusConfig {
  EVENT_BUS: 'mongo' | 'rabbitmq';
  EVENT_STORE_URL: string;
  RABBITMQ_URL: string;
}

/** Picks the transport from config: RabbitMQ when available, MongoDB otherwise. */
export async function createEventBus(
  config: EventBusConfig,
  logger: Logger,
  options: MongoEventBusOptions & RabbitMqEventBusOptions = {},
): Promise<EventBus> {
  const bus =
    config.EVENT_BUS === 'rabbitmq'
      ? await RabbitMqEventBus.connect(config.RABBITMQ_URL, logger, options)
      : await MongoEventBus.connect(config.EVENT_STORE_URL, logger, options);
  logger.info({ transport: bus.kind }, 'event bus connected');
  return bus;
}
