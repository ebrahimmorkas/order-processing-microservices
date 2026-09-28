import request from 'supertest';
import type { Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, verifyToken, type DomainEvent, type EventBus } from '@ops/common';
import { createAuthService } from '../src/service.js';
import {
  dropAndClose,
  dropDatabase,
  eventually,
  gatewayUser,
  testBus,
  testDb,
} from '../../../test/helpers.js';

const secret = process.env.JWT_SECRET!;

describe('auth service', () => {
  let connection: Connection;
  let bus: EventBus;
  let busUrl: string;
  let app: ReturnType<typeof createAuthService>['app'];
  const published: DomainEvent[] = [];

  beforeAll(async () => {
    connection = await testDb('ops_auth_test');
    ({ bus, url: busUrl } = await testBus());
    await bus.subscribe('test-listener', ['user.registered'], async (e) => void published.push(e));
    app = createAuthService({
      connection,
      bus,
      logger: createLogger('auth'),
      jwtSecret: secret,
    }).app;
  });

  afterAll(async () => {
    await bus.close();
    await dropAndClose(connection);
    await dropDatabase(busUrl);
  });

  it('registers a user, issues a JWT and publishes user.registered', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'Grace@Example.com', name: 'Grace Hopper', password: 'Cobol1959' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'grace@example.com', name: 'Grace Hopper' });
    expect(verifyToken(res.body.token, secret)).toEqual({
      id: res.body.user.id,
      email: 'grace@example.com',
    });

    const event = await eventually(() =>
      published.find((e) => e.data && e.type === 'user.registered'),
    );
    expect(event).toMatchObject({ source: 'auth', data: { email: 'grace@example.com' } });
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const body = { email: 'dup@example.com', name: 'Dup', password: 'Password1' };
    await request(app).post('/auth/register').send(body);
    const dup = await request(app).post('/auth/register').send(body);
    expect(dup.status).toBe(409);

    const weak = await request(app)
      .post('/auth/register')
      .send({ ...body, email: 'weak@example.com', password: 'short' });
    expect(weak.status).toBe(400);
  });

  it('logs in and returns the profile for the gateway user', async () => {
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'ada@example.com', name: 'Ada', password: 'Engine1843' });

    const bad = await request(app)
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong-pass1' });
    expect(bad.status).toBe(401);

    const ok = await request(app)
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: 'Engine1843' });
    expect(ok.status).toBe(200);

    const me = await request(app).get('/auth/me').set(gatewayUser(reg.body.user.id));
    expect(me.body.user.email).toBe('ada@example.com');
  });

  it('reports health', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toEqual({ service: 'auth', status: 'ok' });
  });
});
