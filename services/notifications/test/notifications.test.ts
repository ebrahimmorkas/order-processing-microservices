import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvent, createLogger, type EventBus } from '@ops/common';
import { InMemoryEmailSender } from '../src/email.js';
import { createNotificationsService } from '../src/service.js';
import {
  dropAndClose,
  dropDatabase,
  eventually,
  gatewayUser,
  testBus,
  testDb,
} from '../../../test/helpers.js';

describe('notifications service', () => {
  let connection: Connection;
  let bus: EventBus;
  let busUrl: string;
  let service: ReturnType<typeof createNotificationsService>;
  const email = new InMemoryEmailSender();
  const userId = randomUUID();
  const user = gatewayUser(userId);

  const list = async () => (await request(service.app).get('/notifications').set(user)).body;

  beforeAll(async () => {
    connection = await testDb('ops_notifications_test');
    ({ bus, url: busUrl } = await testBus());
    service = createNotificationsService({
      connection,
      bus,
      logger: createLogger('notifications'),
      email,
    });
    await service.start();
  });

  afterAll(async () => {
    await bus.close();
    await dropAndClose(connection);
    await dropDatabase(busUrl);
  });

  it('welcomes new users and remembers their contact details', async () => {
    await bus.publish(
      createEvent(
        'user.registered',
        { userId, email: 'linus@example.com', name: 'Linus' },
        { source: 'auth' },
      ),
    );
    await eventually(() => email.sent.find((m) => m.to === 'linus@example.com'));
    const body = await list();
    expect(body.data[0]).toMatchObject({ type: 'WELCOME', title: 'Welcome, Linus!', read: false });
  });

  it('notifies on order outcomes exactly once per event', async () => {
    const orderId = '66f00000000000000000abcd';
    const confirmed = createEvent(
      'order.confirmed',
      { orderId, userId, totalCents: 12345 },
      { source: 'orders' },
    );
    await bus.publish(confirmed);
    await bus.publish(confirmed); // duplicate delivery

    await eventually(async () =>
      (await list()).data.some((n: { type: string }) => n.type === 'ORDER_CONFIRMED'),
    );
    await new Promise((r) => setTimeout(r, 300));
    const body = await list();
    const confirmations = body.data.filter((n: { type: string }) => n.type === 'ORDER_CONFIRMED');
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].message).toContain('$123.45');
    expect(email.sent.filter((m) => m.subject.includes('confirmed'))).toHaveLength(1);
  });

  it('marks notifications as read and isolates users', async () => {
    const before = await list();
    const target = before.data[0];
    const other = await request(service.app)
      .post(`/notifications/${target.id}/read`)
      .set(gatewayUser('someone-else'));
    expect(other.status).toBe(404);

    const read = await request(service.app).post(`/notifications/${target.id}/read`).set(user);
    expect(read.body.notification.read).toBe(true);

    const after = await list();
    expect(after.unreadCount).toBe(before.unreadCount - 1);
    const unreadOnly = await request(service.app).get('/notifications?unread=true').set(user);
    expect(unreadOnly.body.data.every((n: { read: boolean }) => !n.read)).toBe(true);
  });
});
