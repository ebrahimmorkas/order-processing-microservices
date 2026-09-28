import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '../helpers.js';
import { startStack } from './stack.js';

type Stack = Awaited<ReturnType<typeof startStack>>;

describe('order saga (end to end through the gateway)', () => {
  let stack: Stack;
  let api: ReturnType<typeof request>;
  let auth: { Authorization: string };

  const order = async (id: string) =>
    (await api.get(`/api/orders/${id}`).set(auth)).body.order as {
      status: string;
      totalCents: number | null;
      rejectionReason: string | null;
    };
  const settled = (id: string) =>
    eventually(async () => {
      const current = await order(id);
      return current.status !== 'PENDING' ? current : null;
    });
  const stock = async (sku: string) =>
    (await api.get(`/api/products/${sku}`)).body.product.stock as number;
  const notifications = async () =>
    (await api.get('/api/notifications').set(auth)).body.data as { type: string }[];

  beforeAll(async () => {
    stack = await startStack();
    api = request(stack.gatewayUrl);
    const res = await api
      .post('/api/auth/register')
      .send({ email: 'buyer@example.com', name: 'Buyer', password: 'Password123' });
    expect(res.status).toBe(201);
    auth = { Authorization: `Bearer ${res.body.token}` };
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('welcomes the new user (auth → notifications)', async () => {
    await eventually(async () => (await notifications()).some((n) => n.type === 'WELCOME'));
    await eventually(() => stack.email.sent.find((m) => m.to === 'buyer@example.com'));
  });

  it('confirms an order when stock is available (orders → inventory → orders → notifications)', async () => {
    const placed = await api
      .post('/api/orders')
      .set(auth)
      .set('x-request-id', 'e2e-trace-1')
      .send({
        items: [
          { sku: 'KB-01', quantity: 2 },
          { sku: 'MS-02', quantity: 1 },
        ],
      });
    expect(placed.status).toBe(202);
    expect(placed.body.order.status).toBe('PENDING');

    const result = await settled(placed.body.order.id);
    expect(result).toMatchObject({ status: 'CONFIRMED', totalCents: 2 * 8999 + 2999 });
    expect(await stock('KB-01')).toBe(48);

    await eventually(async () => (await notifications()).some((n) => n.type === 'ORDER_CONFIRMED'));

    // Every event of this order carries the id of the originating request.
    const store = await mongoose.createConnection(stack.eventStoreUrl).asPromise();
    if (stack.transport === 'mongo') {
      const events = await store
        .collection('events')
        .find({ 'event.data.orderId': placed.body.order.id })
        .toArray();
      const types = events.map((e) => e.event.type).sort();
      expect(types).toEqual(['inventory.reserved', 'order.confirmed', 'order.created']);
      expect(new Set(events.map((e) => e.event.correlationId))).toEqual(new Set(['e2e-trace-1']));
    }
    await store.close();
  });

  it('rejects an order that exceeds stock and leaves inventory untouched', async () => {
    const placed = await api
      .post('/api/orders')
      .set(auth)
      .send({
        items: [
          { sku: 'MS-02', quantity: 1 },
          { sku: 'LT-01', quantity: 5 },
        ],
      });
    const result = await settled(placed.body.order.id);
    expect(result).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Insufficient stock for LT-01',
    });
    expect(await stock('LT-01')).toBe(2);
    expect(await stock('MS-02')).toBe(99);
    await eventually(async () => (await notifications()).some((n) => n.type === 'ORDER_REJECTED'));
  });

  it('compensates on cancellation: stock is returned', async () => {
    const placed = await api
      .post('/api/orders')
      .set(auth)
      .send({ items: [{ sku: 'HD-03', quantity: 3 }] });
    await settled(placed.body.order.id);
    expect(await stock('HD-03')).toBe(22);

    const cancelled = await api.post(`/api/orders/${placed.body.order.id}/cancel`).set(auth);
    expect(cancelled.body.order.status).toBe('CANCELLED');
    await eventually(async () => (await stock('HD-03')) === 25);
    await eventually(async () => (await notifications()).some((n) => n.type === 'ORDER_CANCELLED'));
  });

  it('only sells the last units once under concurrent orders', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api
          .post('/api/orders')
          .set(auth)
          .send({ items: [{ sku: 'LT-01', quantity: 1 }] }),
      ),
    );
    const outcomes = await Promise.all(results.map((r) => settled(r.body.order.id)));
    expect(outcomes.filter((o) => o.status === 'CONFIRMED')).toHaveLength(2);
    expect(outcomes.filter((o) => o.status === 'REJECTED')).toHaveLength(3);
    expect(await stock('LT-01')).toBe(0);
  });

  it('reports the whole system as healthy', async () => {
    const health = await api.get('/health');
    expect(health.body).toEqual({
      status: 'ok',
      services: { auth: 'up', orders: 'up', inventory: 'up', notifications: 'up' },
    });
  });
});
