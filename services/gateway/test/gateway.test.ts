import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, listen, signToken, type RunningServer } from '@ops/common';
import { createGateway } from '../src/gateway.js';

const secret = process.env.JWT_SECRET!;

/** Fake upstream that echoes what it received. */
function echoService(name: string) {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.all(/.*/, (req, res) => {
    res.json({
      service: name,
      method: req.method,
      path: req.originalUrl,
      body: req.body,
      userId: req.header('x-user-id') ?? null,
      requestId: req.header('x-request-id') ?? null,
    });
  });
  return app;
}

describe('api gateway', () => {
  const upstreams: RunningServer[] = [];
  let gateway: ReturnType<typeof createGateway>;
  const token = signToken({ id: 'user-1', email: 'u1@test.dev' }, secret);
  const auth = { Authorization: `Bearer ${token}` };

  beforeAll(async () => {
    for (const name of ['auth', 'orders', 'inventory']) {
      upstreams.push(await listen(echoService(name), 0));
    }
    const [authSvc, orders, inventory] = upstreams;
    gateway = createGateway({
      logger: createLogger('gateway'),
      jwtSecret: secret,
      rateLimit: { windowMs: 60_000, max: 1000, authMax: 5 },
      upstreams: {
        auth: authSvc!.url,
        orders: orders!.url,
        inventory: inventory!.url,
        // Nothing listens here: simulates a service that is down.
        notifications: 'http://127.0.0.1:1',
      },
    });
  });

  afterAll(async () => {
    await Promise.all(upstreams.map((u) => u.close()));
  });

  it('routes public requests without a token and rewrites paths', async () => {
    const res = await request(gateway).get('/api/products/KB-01?x=1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      service: 'inventory',
      path: '/products/KB-01?x=1',
      userId: null,
    });

    const list = await request(gateway).get('/api/products');
    expect(list.body.path).toBe('/products');
  });

  it('requires a valid token for protected routes', async () => {
    expect((await request(gateway).get('/api/orders')).status).toBe(401);
    const bad = await request(gateway).get('/api/orders').set('Authorization', 'Bearer nope');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('UNAUTHORIZED');
  });

  it('forwards the verified identity and strips spoofed identity headers', async () => {
    const res = await request(gateway)
      .get('/api/orders?status=PENDING')
      .set(auth)
      .set('x-user-id', 'attacker');
    expect(res.body).toMatchObject({
      service: 'orders',
      path: '/orders?status=PENDING',
      userId: 'user-1',
    });

    const anon = await request(gateway).get('/api/products').set('x-user-id', 'attacker');
    expect(anon.body.userId).toBeNull();
  });

  it('streams request bodies through and propagates the request id', async () => {
    const res = await request(gateway)
      .post('/api/orders')
      .set(auth)
      .set('x-request-id', 'trace-42')
      .send({ items: [{ sku: 'KB-01', quantity: 1 }] });
    expect(res.body).toMatchObject({
      method: 'POST',
      body: { items: [{ sku: 'KB-01', quantity: 1 }] },
      requestId: 'trace-42',
    });
    expect(res.headers['x-request-id']).toBe('trace-42');
  });

  it('answers 502 when an upstream is down and reports degraded health', async () => {
    const res = await request(gateway).get('/api/notifications').set(auth);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BAD_GATEWAY');

    const health = await request(gateway).get('/health');
    expect(health.status).toBe(503);
    expect(health.body).toEqual({
      status: 'degraded',
      services: { auth: 'up', orders: 'up', inventory: 'up', notifications: 'down' },
    });
  });

  it('rate limits the auth endpoints more strictly', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await request(gateway).post('/api/auth/login').send({})).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
