import { randomUUID } from 'node:crypto';
import mongoose, { type Connection } from 'mongoose';
import {
  connectMongo,
  createLogger,
  listen,
  MongoEventBus,
  RabbitMqEventBus,
  type EventBus,
  type RunningServer,
} from '@ops/common';
import { createAuthService } from '../../services/auth/src/service.js';
import { createGateway } from '../../services/gateway/src/gateway.js';
import { createInventoryService } from '../../services/inventory/src/service.js';
import { InMemoryEmailSender } from '../../services/notifications/src/email.js';
import { createNotificationsService } from '../../services/notifications/src/service.js';
import { createOrdersService } from '../../services/orders/src/service.js';

/**
 * Boots the whole system in-process: every service gets its own database and
 * its own event-bus connection, exactly like separate deployments; they only
 * talk to each other through the bus and the gateway.
 */
export async function startStack() {
  const suffix = randomUUID().slice(0, 8);
  const mongo = process.env.TEST_MONGO_URL ?? 'mongodb://localhost:27017';
  const eventStoreUrl = `${mongo}/ops_e2e_events_${suffix}`;
  const jwtSecret = process.env.JWT_SECRET!;
  const useRabbit = process.env.EVENT_BUS === 'rabbitmq' && !!process.env.RABBITMQ_URL;

  const connections: Connection[] = [];
  const buses: EventBus[] = [];
  const servers: RunningServer[] = [];
  const stoppers: (() => Promise<void>)[] = [];

  const deps = async (service: string) => {
    const connection = await connectMongo(`${mongo}/ops_e2e_${service}_${suffix}`);
    const logger = createLogger(service);
    const bus = useRabbit
      ? await RabbitMqEventBus.connect(process.env.RABBITMQ_URL!, logger, { backoffBaseMs: 50 })
      : await MongoEventBus.connect(eventStoreUrl, logger, {
          pollIntervalMs: 20,
          backoffBaseMs: 20,
        });
    connections.push(connection);
    buses.push(bus);
    return { connection, logger, bus };
  };

  const boot = async (service: {
    app: Parameters<typeof listen>[0];
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }) => {
    await service.start();
    stoppers.push(service.stop);
    const server = await listen(service.app, 0);
    servers.push(server);
    return server;
  };

  const email = new InMemoryEmailSender();
  const auth = await boot(createAuthService({ ...(await deps('auth')), jwtSecret }));
  const inventoryService = createInventoryService({
    ...(await deps('inventory')),
    seedCatalog: true,
  });
  const inventory = await boot(inventoryService);
  const orders = await boot(
    createOrdersService({ ...(await deps('orders')), relayIntervalMs: 50 }),
  );
  const notifications = await boot(
    createNotificationsService({ ...(await deps('notifications')), email }),
  );

  const gateway = await listen(
    createGateway({
      logger: createLogger('gateway'),
      jwtSecret,
      upstreams: {
        auth: auth.url,
        orders: orders.url,
        inventory: inventory.url,
        notifications: notifications.url,
      },
    }),
    0,
  );
  servers.push(gateway);

  return {
    gatewayUrl: gateway.url,
    email,
    eventStoreUrl,
    transport: useRabbit ? 'rabbitmq' : 'mongo',
    async stop() {
      await Promise.all(servers.map((s) => s.close()));
      await Promise.all(stoppers.map((stop) => stop()));
      await Promise.all(buses.map((b) => b.close()));
      for (const connection of connections) {
        await connection.dropDatabase();
        await connection.close();
      }
      const store = await mongoose.createConnection(eventStoreUrl).asPromise();
      await store.dropDatabase();
      await store.close();
    },
  };
}
