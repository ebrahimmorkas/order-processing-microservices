import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Connection } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEvent, createLogger, type DomainEvent, type EventBus } from '@ops/common';
import { createInventoryService } from '../src/service.js';
import { dropAndClose, dropDatabase, eventually, testBus, testDb } from '../../../test/helpers.js';

describe('inventory service', () => {
  let connection: Connection;
  let bus: EventBus;
  let busUrl: string;
  let service: ReturnType<typeof createInventoryService>;
  const events: DomainEvent[] = [];

  const orderCreated = (items: { sku: string; quantity: number }[], orderId = randomUUID()) =>
    createEvent('order.created', { orderId, userId: 'u1', items }, { source: 'orders' });

  const replyFor = (orderId: string) =>
    eventually(() =>
      events.find(
        (e) =>
          e.type !== 'inventory.released' && (e.data as { orderId: string }).orderId === orderId,
      ),
    );

  const stockOf = async (sku: string) => (await service.Product.findOne({ sku }))!.stock;

  beforeAll(async () => {
    connection = await testDb('ops_inventory_test');
    ({ bus, url: busUrl } = await testBus());
    await bus.subscribe(
      'spy',
      ['inventory.reserved', 'inventory.rejected', 'inventory.released'],
      async (e) => void events.push(e),
    );
    service = createInventoryService({ connection, bus, logger: createLogger('inventory') });
    await service.start();
  });

  beforeEach(async () => {
    await service.Product.deleteMany({});
    await service.Product.insertMany([
      { sku: 'KB-01', name: 'Keyboard', priceCents: 5000, stock: 10 },
      { sku: 'MS-02', name: 'Mouse', priceCents: 2000, stock: 5 },
      { sku: 'LT-01', name: 'Lamp', priceCents: 3000, stock: 1 },
    ]);
  });

  afterAll(async () => {
    await bus.close();
    await dropAndClose(connection);
    await dropDatabase(busUrl);
  });

  it('serves the catalog', async () => {
    const list = await request(service.app).get('/products');
    expect(list.body.data.map((p: { sku: string }) => p.sku)).toEqual(['KB-01', 'LT-01', 'MS-02']);
    const one = await request(service.app).get('/products/kb-01');
    expect(one.body.product).toMatchObject({ name: 'Keyboard', priceCents: 5000, stock: 10 });
    expect((await request(service.app).get('/products/NOPE')).status).toBe(404);
  });

  it('reserves stock and replies with priced lines', async () => {
    const event = orderCreated([
      { sku: 'KB-01', quantity: 2 },
      { sku: 'MS-02', quantity: 1 },
    ]);
    await bus.publish(event);
    const reply = await replyFor((event.data as { orderId: string }).orderId);

    expect(reply.type).toBe('inventory.reserved');
    expect(reply.correlationId).toBe(event.correlationId);
    expect(reply.data).toMatchObject({ totalCents: 12000 });
    expect(await stockOf('KB-01')).toBe(8);
    expect(await stockOf('MS-02')).toBe(4);
  });

  it('rejects and rolls back partial reservations when any line is short', async () => {
    const event = orderCreated([
      { sku: 'KB-01', quantity: 3 },
      { sku: 'MS-02', quantity: 99 },
    ]);
    await bus.publish(event);
    const reply = await replyFor((event.data as { orderId: string }).orderId);

    expect(reply.type).toBe('inventory.rejected');
    expect(reply.data).toMatchObject({ reason: 'Insufficient stock for MS-02' });
    expect(await stockOf('KB-01')).toBe(10);
  });

  it('never oversells the last unit to concurrent orders', async () => {
    const orders = Array.from({ length: 6 }, () => orderCreated([{ sku: 'LT-01', quantity: 1 }]));
    await Promise.all(orders.map((o) => bus.publish(o)));
    const replies = await Promise.all(
      orders.map((o) => replyFor((o.data as { orderId: string }).orderId)),
    );
    expect(replies.filter((r) => r.type === 'inventory.reserved')).toHaveLength(1);
    expect(await stockOf('LT-01')).toBe(0);
  });

  it('returns stock when a reserved order is cancelled', async () => {
    const created = orderCreated([{ sku: 'KB-01', quantity: 4 }]);
    const orderId = (created.data as { orderId: string }).orderId;
    await bus.publish(created);
    await replyFor(orderId);
    expect(await stockOf('KB-01')).toBe(6);

    await bus.publish(
      createEvent(
        'order.cancelled',
        { orderId, previousStatus: 'CONFIRMED' },
        { source: 'orders' },
      ),
    );
    await eventually(() =>
      events.find(
        (e) =>
          e.type === 'inventory.released' && (e.data as { orderId: string }).orderId === orderId,
      ),
    );
    expect(await stockOf('KB-01')).toBe(10);
  });

  it('ignores an order.created that arrives after its cancellation', async () => {
    const orderId = randomUUID();
    await bus.publish(createEvent('order.cancelled', { orderId }, { source: 'orders' }));
    await eventually(
      async () => (await service.Reservation.findOne({ orderId }))?.status === 'CANCELLED',
    );

    await bus.publish(orderCreated([{ sku: 'KB-01', quantity: 1 }], orderId));
    await new Promise((r) => setTimeout(r, 300));
    expect(await stockOf('KB-01')).toBe(10);
  });

  it('resumes an interrupted reservation without double-decrementing', async () => {
    const orderId = randomUUID();
    // Simulate a crash after holding KB-01 but before finishing.
    await service.Reservation.create({ orderId, status: 'PENDING' });
    await service.Product.updateOne(
      { sku: 'KB-01' },
      { $inc: { stock: -2 }, $push: { holds: { orderId, quantity: 2 } } },
    );

    await bus.publish(
      orderCreated(
        [
          { sku: 'KB-01', quantity: 2 },
          { sku: 'MS-02', quantity: 1 },
        ],
        orderId,
      ),
    );
    const reply = await replyFor(orderId);
    expect(reply.type).toBe('inventory.reserved');
    expect(await stockOf('KB-01')).toBe(8);
    expect(await stockOf('MS-02')).toBe(4);
  });
});
