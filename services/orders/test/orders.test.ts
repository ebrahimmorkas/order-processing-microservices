import request from 'supertest';
import type { Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvent, createLogger, type DomainEvent, type EventBus } from '@ops/common';
import { createOrdersService } from '../src/service.js';
import {
  dropAndClose,
  dropDatabase,
  eventually,
  gatewayUser,
  testBus,
  testDb,
} from '../../../test/helpers.js';

describe('orders service', () => {
  let connection: Connection;
  let bus: EventBus;
  let busUrl: string;
  let service: ReturnType<typeof createOrdersService>;
  const events: DomainEvent[] = [];
  const alice = gatewayUser('user-alice');
  const bob = gatewayUser('user-bob');

  const eventFor = (type: string, orderId: string) =>
    eventually(() =>
      events.find((e) => e.type === type && (e.data as { orderId: string }).orderId === orderId),
    );

  const place = (items: object[], headers: Record<string, string> = alice) =>
    request(service.app).post('/orders').set(headers).send({ items });

  const status = async (id: string) =>
    (await request(service.app).get(`/orders/${id}`).set(alice)).body.order.status as string;

  beforeAll(async () => {
    connection = await testDb('ops_orders_test');
    ({ bus, url: busUrl } = await testBus());
    // Stand-in for downstream consumers (inventory, notifications).
    await bus.subscribe(
      'spy',
      ['order.created', 'order.confirmed', 'order.rejected', 'order.cancelled'],
      async (e) => void events.push(e),
    );
    service = createOrdersService({
      connection,
      bus,
      logger: createLogger('orders'),
      relayIntervalMs: 50,
    });
    await service.start();
  });

  afterAll(async () => {
    await service.stop();
    await bus.close();
    await dropAndClose(connection);
    await dropDatabase(busUrl);
  });

  it('accepts an order as PENDING and publishes order.created via the outbox', async () => {
    const res = await place([
      { sku: 'kb-01', quantity: 1 },
      { sku: 'KB-01', quantity: 2 },
      { sku: 'MS-02', quantity: 1 },
    ]);
    expect(res.status).toBe(202);
    expect(res.body.order).toMatchObject({ status: 'PENDING', userId: 'user-alice' });
    // Duplicate SKUs are merged.
    expect(res.body.order.items).toEqual([
      { sku: 'KB-01', quantity: 3 },
      { sku: 'MS-02', quantity: 1 },
    ]);

    const created = await eventFor('order.created', res.body.order.id);
    expect(created.source).toBe('orders');
    // The outbox is drained once published.
    await eventually(async () => {
      const doc = await service.Order.findById(res.body.order.id).lean();
      return doc?.outbox.length === 0;
    });
  });

  it('confirms the order when inventory reserves stock (exactly once)', async () => {
    const { body } = await place([{ sku: 'KB-01', quantity: 2 }]);
    const orderId = body.order.id;
    const created = await eventFor('order.created', orderId);

    const reserved = createEvent(
      'inventory.reserved',
      { orderId, lines: [{ sku: 'KB-01', quantity: 2, unitPriceCents: 4999 }], totalCents: 9998 },
      { source: 'inventory', correlationId: created.correlationId },
    );
    await bus.publish(reserved);
    await bus.publish(reserved); // duplicate delivery must be harmless

    await eventually(async () => (await status(orderId)) === 'CONFIRMED');
    const confirmed = await eventFor('order.confirmed', orderId);
    expect(confirmed.data).toMatchObject({ userId: 'user-alice', totalCents: 9998 });
    expect(confirmed.correlationId).toBe(created.correlationId);

    await new Promise((r) => setTimeout(r, 300));
    expect(
      events.filter(
        (e) => e.type === 'order.confirmed' && (e.data as { orderId: string }).orderId === orderId,
      ),
    ).toHaveLength(1);
  });

  it('rejects the order when inventory cannot reserve', async () => {
    const { body } = await place([{ sku: 'RARE-1', quantity: 99 }]);
    const orderId = body.order.id;
    await bus.publish(
      createEvent(
        'inventory.rejected',
        { orderId, reason: 'Insufficient stock for RARE-1' },
        { source: 'inventory' },
      ),
    );
    await eventually(async () => (await status(orderId)) === 'REJECTED');
    const rejected = await eventFor('order.rejected', orderId);
    expect(rejected.data).toMatchObject({ reason: 'Insufficient stock for RARE-1' });
  });

  it('cancels orders and ignores late inventory replies for them', async () => {
    const { body } = await place([{ sku: 'KB-01', quantity: 1 }]);
    const orderId = body.order.id;

    const cancel = await request(service.app).post(`/orders/${orderId}/cancel`).set(alice);
    expect(cancel.body.order.status).toBe('CANCELLED');
    const cancelled = await eventFor('order.cancelled', orderId);
    expect(cancelled.data).toMatchObject({ previousStatus: 'PENDING' });

    await bus.publish(
      createEvent(
        'inventory.reserved',
        { orderId, lines: [], totalCents: 0 },
        { source: 'inventory' },
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(await status(orderId)).toBe('CANCELLED');

    const again = await request(service.app).post(`/orders/${orderId}/cancel`).set(alice);
    expect(again.status).toBe(409);
  });

  it('supports idempotency keys for safe retries', async () => {
    const send = () =>
      request(service.app)
        .post('/orders')
        .set(alice)
        .set('Idempotency-Key', 'checkout-attempt-1')
        .send({ items: [{ sku: 'KB-01', quantity: 1 }] });
    const first = await send();
    const retry = await send();
    expect(first.status).toBe(202);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.order.id).toBe(first.body.order.id);
  });

  it("isolates users' orders and validates input", async () => {
    const { body } = await place([{ sku: 'KB-01', quantity: 1 }]);
    const peek = await request(service.app).get(`/orders/${body.order.id}`).set(bob);
    expect(peek.status).toBe(404);

    expect((await request(service.app).get('/orders')).status).toBe(401);
    expect((await place([])).status).toBe(400);
    expect((await place([{ sku: 'X', quantity: 0 }])).status).toBe(400);

    const mine = await request(service.app).get('/orders?status=PENDING').set(bob);
    expect(mine.body.data).toEqual([]);
  });
});
