import { Router } from 'express';
import { isValidObjectId, Schema, type Connection } from 'mongoose';
import { z } from 'zod';
import {
  createBaseApp,
  finalizeApp,
  idempotent,
  NotFound,
  parse,
  requireGatewayUser,
  type DomainEvent,
  type EventBus,
  type Logger,
} from '@ops/common';
import type { EmailSender } from './email.js';

export const SERVICE = 'notifications';

export interface NotificationsServiceDeps {
  connection: Connection;
  bus: EventBus;
  logger: Logger;
  email: EmailSender;
}

const formatMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const shortId = (id: string) => id.slice(-6).toUpperCase();

export function createNotificationsService({
  connection,
  bus,
  logger,
  email,
}: NotificationsServiceDeps) {
  /**
   * Local read model of users, built from `user.registered` events, so this
   * service never needs a synchronous call to the auth service.
   */
  const UserContact = connection.model(
    'UserContact',
    new Schema({ _id: String, email: String, name: String }, { timestamps: true }),
  );

  const notificationSchema = new Schema(
    {
      userId: { type: String, required: true },
      type: { type: String, required: true },
      title: { type: String, required: true },
      message: { type: String, required: true },
      read: { type: Boolean, default: false },
      /** The source event: unique, so each event produces at most one notification. */
      eventId: { type: String, required: true, unique: true },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
  );
  notificationSchema.index({ userId: 1, createdAt: -1 });
  const Notification = connection.model('Notification', notificationSchema);

  async function notify(
    event: DomainEvent,
    userId: string,
    type: string,
    title: string,
    message: string,
  ) {
    const result = await Notification.updateOne(
      { eventId: event.id },
      { $setOnInsert: { userId, type, title, message } },
      { upsert: true },
    );
    if (result.upsertedCount === 0) return; // already handled
    const contact = await UserContact.findById(userId).lean();
    if (contact?.email) {
      await email.send({ to: contact.email, subject: title, text: message });
    } else {
      logger.warn({ userId }, 'no contact details for user; skipping email');
    }
  }

  async function handle(event: DomainEvent) {
    const data = event.data as Record<string, unknown>;
    switch (event.type) {
      case 'user.registered': {
        const {
          userId,
          email: address,
          name,
        } = data as {
          userId: string;
          email: string;
          name: string;
        };
        await UserContact.updateOne(
          { _id: userId },
          { $set: { email: address, name } },
          { upsert: true },
        );
        await notify(event, userId, 'WELCOME', `Welcome, ${name}!`, 'Your account is ready.');
        return;
      }
      case 'order.confirmed': {
        const { orderId, userId, totalCents } = data as {
          orderId: string;
          userId: string;
          totalCents: number;
        };
        await notify(
          event,
          userId,
          'ORDER_CONFIRMED',
          `Order #${shortId(orderId)} confirmed`,
          `Your order has been confirmed. Total: ${formatMoney(totalCents)}.`,
        );
        return;
      }
      case 'order.rejected': {
        const { orderId, userId, reason } = data as {
          orderId: string;
          userId: string;
          reason: string;
        };
        await notify(
          event,
          userId,
          'ORDER_REJECTED',
          `Order #${shortId(orderId)} could not be placed`,
          `We couldn't complete your order: ${reason}.`,
        );
        return;
      }
      case 'order.cancelled': {
        const { orderId, userId } = data as { orderId: string; userId: string };
        await notify(
          event,
          userId,
          'ORDER_CANCELLED',
          `Order #${shortId(orderId)} cancelled`,
          'Your order was cancelled and any reserved items were released.',
        );
        return;
      }
    }
  }

  const serialize = (n: InstanceType<typeof Notification>) => ({
    id: n.id as string,
    type: n.type,
    title: n.title,
    message: n.message,
    read: n.read,
    createdAt: n.createdAt,
  });

  const router = Router();
  router.get('/health', (_req, res) => {
    const up = connection.readyState === 1;
    res.status(up ? 200 : 503).json({ service: SERVICE, status: up ? 'ok' : 'degraded' });
  });

  router.use('/notifications', requireGatewayUser);

  router.get('/notifications', async (req, res) => {
    const { unread, limit } = parse(
      z.object({
        unread: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
      req.query,
    );
    const filter = { userId: req.user!.id, ...(unread === 'true' && { read: false }) };
    const [items, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(limit),
      Notification.countDocuments({ userId: req.user!.id, read: false }),
    ]);
    res.json({ data: items.map(serialize), unreadCount });
  });

  router.post('/notifications/:id/read', async (req, res) => {
    const id = req.params.id as string;
    if (!isValidObjectId(id)) throw NotFound('Notification');
    const updated = await Notification.findOneAndUpdate(
      { _id: id, userId: req.user!.id },
      { $set: { read: true } },
      { returnDocument: 'after' },
    );
    if (!updated) throw NotFound('Notification');
    res.json({ notification: serialize(updated) });
  });

  const app = createBaseApp(logger);
  app.use(router);
  finalizeApp(app, logger);

  return {
    app,
    Notification,
    async start() {
      await bus.subscribe(
        SERVICE,
        ['user.registered', 'order.confirmed', 'order.rejected', 'order.cancelled'],
        idempotent(connection, SERVICE, handle),
      );
    },
    async stop() {},
  };
}
