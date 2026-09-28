import { randomUUID } from 'node:crypto';
import mongoose, { type Connection } from 'mongoose';
import { createLogger, MongoEventBus, type EventBus } from '@ops/common';

const base = () => process.env.TEST_MONGO_URL ?? 'mongodb://localhost:27017';

/** Isolated database per test file; dropped by `cleanup()`. */
export async function testDb(prefix: string): Promise<Connection> {
  return mongoose.createConnection(`${base()}/${prefix}_${randomUUID().slice(0, 8)}`).asPromise();
}

export async function dropAndClose(connection: Connection) {
  await connection.dropDatabase();
  await connection.close();
}

/** Mongo event bus on its own event store, polling fast for quick tests. */
export async function testBus(): Promise<{ bus: EventBus; url: string }> {
  const url = `${base()}/ops_events_${randomUUID().slice(0, 8)}`;
  const bus = await MongoEventBus.connect(url, createLogger('test-bus'), {
    pollIntervalMs: 20,
    backoffBaseMs: 10,
  });
  return { bus, url };
}

export async function dropDatabase(url: string) {
  const connection = await mongoose.createConnection(url).asPromise();
  await dropAndClose(connection);
}

export async function eventually<T>(
  check: () => T | Promise<T>,
  timeoutMs = 10_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms (last value: ${JSON.stringify(last)})`);
}

export const gatewayUser = (id: string, email = `${id}@test.dev`) => ({
  'x-user-id': id,
  'x-user-email': email,
});
