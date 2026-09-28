import { Router } from 'express';
import { isValidObjectId, type Connection } from 'mongoose';
import { z } from 'zod';
import {
  BadRequest,
  Conflict,
  createBaseApp,
  createEvent,
  finalizeApp,
  idempotent,
  NotFound,
  parse,
  requireGatewayUser,
  type DomainEvent,
  type EventBus,
  type Logger,
} from '@ops/common';
import { createOrderModel, ORDER_STATUSES, type OrderStatus } from './order.model.js';
import { OutboxRelay } from './outbox-relay.js';

export const SERVICE = 'orders';

/** Events this service publishes. */
export const OrderEvents = {
  created: 'order.created',
  confirmed: 'order.confirmed',
  rejected: 'order.rejected',
  cancelled: 'order.cancelled',
} as const;

export interface InventoryReserved {
  orderId: string;
  lines: { sku: string; quantity: number; unitPriceCents: number }[];
  totalCents: number;
}
export interface InventoryRejected {
  orderId: string;
  reason: string;
}

export interface OrdersServiceDeps {
  connection: Connection;
  bus: EventBus;
  logger: Logger;
  relayIntervalMs?: number;
}

const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        sku: z.string().trim().toUpperCase().min(1).max(40),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(20),
});

const listQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function createOrdersService({
  connection,
  bus,
  logger,
  relayIntervalMs,
}: OrdersServiceDeps) {
  const Order = createOrderModel(connection);
  const relay = new OutboxRelay(Order, bus, logger, relayIntervalMs);

  type OrderDoc = InstanceType<typeof Order>;
  const serialize = (order: OrderDoc) => ({
    id: order.id as string,
    userId: order.userId,
    status: order.status,
    items: order.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    lines: order.lines.map((l) => ({
      sku: l.sku,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
    })),
    totalCents: order.totalCents ?? null,
    rejectionReason: order.rejectionReason ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  });

  const event = <T>(type: string, data: T, correlationId: string) =>
    createEvent(type, data, { source: SERVICE, correlationId });

  async function findOwned(userId: string, id: string) {
    if (!isValidObjectId(id)) throw NotFound('Order');
    const order = await Order.findOne({ _id: id, userId });
    if (!order) throw NotFound('Order');
    return order;
  }

  const router = Router();
  router.get('/health', (_req, res) => {
    const up = connection.readyState === 1;
    res.status(up ? 200 : 503).json({ service: SERVICE, status: up ? 'ok' : 'degraded' });
  });

  router.use('/orders', requireGatewayUser);

  /**
   * Places an order in PENDING state and records `order.created` in the outbox.
   * The inventory service reacts asynchronously; clients poll the order (or get
   * a notification) to see it become CONFIRMED or REJECTED.
   */
  router.post('/orders', async (req, res) => {
    const input = parse(createOrderSchema, req.body);
    const idempotencyKey = z
      .string()
      .min(8)
      .max(100)
      .optional()
      .parse(req.header('Idempotency-Key'));
    const userId = req.user!.id;

    if (idempotencyKey) {
      const existing = await Order.findOne({ userId, idempotencyKey });
      if (existing) {
        res
          .status(200)
          .setHeader('Idempotent-Replayed', 'true')
          .json({ order: serialize(existing) });
        return;
      }
    }

    // Merge duplicate SKUs so inventory reserves each product once.
    const merged = new Map<string, number>();
    for (const { sku, quantity } of input.items) merged.set(sku, (merged.get(sku) ?? 0) + quantity);
    const items = [...merged].map(([sku, quantity]) => ({ sku, quantity }));
    if (items.some((i) => i.quantity > 100)) throw BadRequest('At most 100 units per product');

    const correlationId = req.id as string;
    const order = new Order({ userId, items, idempotencyKey, correlationId });
    order.outbox = [
      event(OrderEvents.created, { orderId: order.id, userId, items }, correlationId),
    ];
    try {
      await order.save();
    } catch (err) {
      if (idempotencyKey && (err as { code?: number }).code === 11000) {
        const existing = await Order.findOne({ userId, idempotencyKey });
        if (existing) {
          res
            .status(200)
            .setHeader('Idempotent-Replayed', 'true')
            .json({ order: serialize(existing) });
          return;
        }
      }
      throw err;
    }
    relay.kick();
    res.status(202).json({ order: serialize(order) });
  });

  router.get('/orders', async (req, res) => {
    const { status, limit } = parse(listQuery, req.query);
    const orders = await Order.find({ userId: req.user!.id, ...(status && { status }) })
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json({ data: orders.map(serialize) });
  });

  router.get('/orders/:id', async (req, res) => {
    res.json({ order: serialize(await findOwned(req.user!.id, req.params.id as string)) });
  });

  router.post('/orders/:id/cancel', async (req, res) => {
    const order = await findOwned(req.user!.id, req.params.id as string);
    const cancellable: OrderStatus[] = ['PENDING', 'CONFIRMED'];
    if (!cancellable.includes(order.status)) {
      throw Conflict(`Cannot cancel an order that is ${order.status}`, 'ORDER_NOT_CANCELLABLE');
    }
    const cancelledEvent = event(
      OrderEvents.cancelled,
      { orderId: order.id, userId: order.userId, previousStatus: order.status },
      order.correlationId,
    );
    // Conditional on the status we read, so a concurrent saga update can't be overwritten.
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: order.status },
      { $set: { status: 'CANCELLED' }, $push: { outbox: cancelledEvent } },
      { returnDocument: 'after' },
    );
    if (!updated) throw Conflict('Order changed concurrently, please retry', 'CONFLICT');
    relay.kick();
    res.json({ order: serialize(updated) });
  });

  /**
   * Saga steps. Each is a single conditional update that both transitions a
   * PENDING order and appends the resulting event to the outbox, so late or
   * duplicate inventory replies can never move an order twice.
   */
  async function transitionPending(
    orderId: string,
    set: Record<string, unknown>,
    buildEvent: (userId: string) => DomainEvent,
  ) {
    if (!isValidObjectId(orderId)) return;
    // userId is immutable, so reading it before the conditional write is safe.
    const current = await Order.findById(orderId, { userId: 1, status: 1 }).lean();
    if (!current || current.status !== 'PENDING') {
      logger.info({ orderId }, 'inventory reply for non-pending order ignored');
      return;
    }
    const result = await Order.updateOne(
      { _id: orderId, status: 'PENDING' },
      { $set: set, $push: { outbox: buildEvent(current.userId) } },
    );
    if (result.modifiedCount === 1) relay.kick();
  }

  const onInventoryReserved = (e: DomainEvent) => {
    const data = e.data as InventoryReserved;
    return transitionPending(
      data.orderId,
      { status: 'CONFIRMED', lines: data.lines, totalCents: data.totalCents },
      (userId) =>
        event(
          OrderEvents.confirmed,
          { orderId: data.orderId, userId, totalCents: data.totalCents, lines: data.lines },
          e.correlationId,
        ),
    );
  };

  const onInventoryRejected = (e: DomainEvent) => {
    const data = e.data as InventoryRejected;
    return transitionPending(
      data.orderId,
      { status: 'REJECTED', rejectionReason: data.reason },
      (userId) =>
        event(
          OrderEvents.rejected,
          { orderId: data.orderId, userId, reason: data.reason },
          e.correlationId,
        ),
    );
  };

  const app = createBaseApp(logger);
  app.use(router);
  finalizeApp(app, logger);

  return {
    app,
    Order,
    async start() {
      await bus.subscribe(
        SERVICE,
        ['inventory.reserved', 'inventory.rejected'],
        idempotent(connection, SERVICE, async (e) => {
          if (e.type === 'inventory.reserved') await onInventoryReserved(e);
          else await onInventoryRejected(e);
        }),
      );
      relay.start();
    },
    async stop() {
      await relay.stop();
    },
  };
}
