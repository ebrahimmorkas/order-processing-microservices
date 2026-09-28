import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createEvent,
  createLogger,
  idempotent,
  MongoEventBus,
  RabbitMqEventBus,
  type DomainEvent,
  type EventBus,
} from '../src/index.js';

const logger = createLogger('event-bus-test');
const mongoBase = process.env.TEST_MONGO_URL!;
const eventStore = `${mongoBase}/ops_events_test_${randomUUID().slice(0, 8)}`;
const fast = { pollIntervalMs: 20, backoffBaseMs: 10 };

const eventually = async (check: () => boolean | Promise<boolean>, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
};

const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}`;

/** Behaviour every transport must guarantee. */
function contract(name: string, connect: () => Promise<EventBus>) {
  describe(`${name} event bus`, () => {
    const buses: EventBus[] = [];
    const open = async () => {
      const bus = await connect();
      buses.push(bus);
      return bus;
    };

    afterAll(async () => {
      await Promise.all(buses.map((b) => b.close()));
    });

    it('fans out to every consumer and filters by event type', async () => {
      const bus = await open();
      const type = unique('thing.created');
      const a: DomainEvent[] = [];
      const b: DomainEvent[] = [];
      const other: DomainEvent[] = [];
      await bus.subscribe(unique('consumer-a'), [type], async (e) => void a.push(e));
      await bus.subscribe(unique('consumer-b'), [type], async (e) => void b.push(e));
      await bus.subscribe(
        unique('consumer-c'),
        [unique('other.type')],
        async (e) => void other.push(e),
      );

      const event = createEvent(type, { n: 1 }, { source: 'test' });
      await bus.publish(event);

      await eventually(() => a.length === 1 && b.length === 1);
      expect(a[0]).toEqual(event);
      expect(other).toHaveLength(0);
    });

    it('load-balances between instances of the same consumer without duplicates', async () => {
      const [first, second] = [await open(), await open()];
      const consumer = unique('workers');
      const type = unique('job.queued');
      const seen: string[] = [];
      const record = async (e: DomainEvent) => void seen.push(e.id);
      await first.subscribe(consumer, [type], record);
      await second.subscribe(consumer, [type], record);

      const events = Array.from({ length: 20 }, (_, i) =>
        createEvent(type, { i }, { source: 'test' }),
      );
      for (const event of events) await first.publish(event);

      await eventually(() => seen.length >= 20);
      await new Promise((r) => setTimeout(r, 200));
      expect(new Set(seen).size).toBe(20);
      expect(seen).toHaveLength(20);
    });

    it('retries a failing handler until it succeeds', async () => {
      const bus = await open();
      const type = unique('flaky.event');
      let calls = 0;
      await bus.subscribe(unique('flaky'), [type], async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient failure');
      });
      await bus.publish(createEvent(type, {}, { source: 'test' }));
      await eventually(() => calls === 3);
    });

    it('dead-letters a message after the maximum attempts', async () => {
      const bus = await open();
      const consumer = unique('doomed');
      const type = unique('poison.event');
      let calls = 0;
      await bus.subscribe(
        consumer,
        [type],
        async () => {
          calls += 1;
          throw new Error('permanent failure');
        },
        { maxAttempts: 3 },
      );
      await bus.publish(createEvent(type, {}, { source: 'test' }));
      await eventually(async () => (await bus.deadLetterCount(consumer)) === 1);
      expect(calls).toBe(3);
    });
  });
}

contract('mongo', () => MongoEventBus.connect(eventStore, logger, fast));

describe.skipIf(!process.env.RABBITMQ_URL)('rabbitmq transport', () => {
  contract('rabbitmq', () => RabbitMqEventBus.connect(process.env.RABBITMQ_URL!, logger, fast));
});

describe('idempotent consumer (inbox)', () => {
  it('processes each event id only once', async () => {
    const connection = await mongoose
      .createConnection(`${mongoBase}/ops_inbox_test_${randomUUID().slice(0, 8)}`)
      .asPromise();
    let calls = 0;
    const handler = idempotent(connection, 'test-consumer', async () => {
      calls += 1;
    });
    const event = createEvent('x.happened', {}, { source: 'test' });
    await handler(event);
    await handler(event);
    await handler({ ...event, id: randomUUID() });
    expect(calls).toBe(2);
    await connection.dropDatabase();
    await connection.close();
  });
});

afterAll(async () => {
  const connection = await mongoose.createConnection(eventStore).asPromise();
  await connection.dropDatabase();
  await connection.close();
});
