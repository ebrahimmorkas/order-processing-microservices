import { Router } from 'express';
import type { Connection } from 'mongoose';
import {
  createBaseApp,
  createEvent,
  finalizeApp,
  idempotent,
  NotFound,
  type DomainEvent,
  type EventBus,
  type Logger,
} from '@ops/common';
import { createModels, DEMO_CATALOG } from './models.js';

export const SERVICE = 'inventory';

export const InventoryEvents = {
  reserved: 'inventory.reserved',
  rejected: 'inventory.rejected',
  released: 'inventory.released',
} as const;

interface OrderCreated {
  orderId: string;
  userId: string;
  items: { sku: string; quantity: number }[];
}

export interface InventoryServiceDeps {
  connection: Connection;
  bus: EventBus;
  logger: Logger;
  seedCatalog?: boolean;
}

export function createInventoryService({
  connection,
  bus,
  logger,
  seedCatalog = false,
}: InventoryServiceDeps) {
  const { Product, Reservation } = createModels(connection);

  const publish = (type: string, data: unknown, cause: DomainEvent) =>
    bus.publish(createEvent(type, data, { source: SERVICE, correlationId: cause.correlationId }));

  /** Returns every unit this order holds, on every product. Idempotent. */
  async function releaseHolds(orderId: string) {
    const products = await Product.find({ 'holds.orderId': orderId }, { holds: 1 });
    for (const product of products) {
      const hold = product.holds.find((h) => h.orderId === orderId);
      if (!hold) continue;
      await Product.updateOne(
        { _id: product._id, 'holds.orderId': orderId },
        { $inc: { stock: hold.quantity }, $pull: { holds: { orderId } } },
      );
    }
  }

  /**
   * Saga participant: tries to hold stock for every line of a new order.
   *
   * 1. Claim the order with a unique reservation record (PENDING).
   * 2. For each SKU, one conditional update decrements stock *and* records the
   *    hold — skipped if this order already holds that SKU (safe to resume).
   * 3. All held → RESERVED + `inventory.reserved`; any shortfall → release
   *    everything, REJECTED + `inventory.rejected`.
   *
   * A redelivered event resumes an unfinished attempt or re-publishes the
   * recorded decision, so the saga converges even if we crashed halfway.
   */
  async function onOrderCreated(event: DomainEvent) {
    const { orderId, items } = event.data as OrderCreated;
    const claim = await Reservation.findOneAndUpdate(
      { orderId },
      { $setOnInsert: { orderId, status: 'PENDING' } },
      { upsert: true, returnDocument: 'after' },
    );

    if (claim.status === 'RESERVED') {
      await publish(
        InventoryEvents.reserved,
        { orderId, lines: claim.lines, totalCents: claim.totalCents },
        event,
      );
      return;
    }
    if (claim.status === 'REJECTED') {
      await publish(InventoryEvents.rejected, { orderId, reason: claim.reason }, event);
      return;
    }
    if (claim.status === 'CANCELLED') return; // order was cancelled before we got here

    const lines: { sku: string; quantity: number; unitPriceCents: number }[] = [];
    let shortfall: string | null = null;

    for (const { sku, quantity } of [...items].sort((a, b) => a.sku.localeCompare(b.sku))) {
      const held = await Product.findOneAndUpdate(
        { sku, stock: { $gte: quantity }, 'holds.orderId': { $ne: orderId } },
        { $inc: { stock: -quantity }, $push: { holds: { orderId, quantity } } },
        { returnDocument: 'after' },
      );
      if (held) {
        lines.push({ sku, quantity, unitPriceCents: held.priceCents });
        continue;
      }
      // Either already held by this order (resumed attempt) or not enough stock.
      const product = await Product.findOne({ sku });
      const existingHold = product?.holds.find((h) => h.orderId === orderId);
      if (product && existingHold) {
        lines.push({ sku, quantity: existingHold.quantity, unitPriceCents: product.priceCents });
        continue;
      }
      shortfall = product ? `Insufficient stock for ${sku}` : `Unknown product ${sku}`;
      break;
    }

    if (shortfall) {
      await releaseHolds(orderId);
      const decided = await Reservation.findOneAndUpdate(
        { orderId, status: 'PENDING' },
        { $set: { status: 'REJECTED', reason: shortfall } },
      );
      if (decided) await publish(InventoryEvents.rejected, { orderId, reason: shortfall }, event);
      return;
    }

    const totalCents = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
    const decided = await Reservation.findOneAndUpdate(
      { orderId, status: 'PENDING' },
      { $set: { status: 'RESERVED', lines, totalCents } },
    );
    if (decided) {
      await publish(InventoryEvents.reserved, { orderId, lines, totalCents }, event);
    } else {
      // Cancelled while we were reserving: give the stock back.
      await releaseHolds(orderId);
    }
  }

  /** Compensation: a cancelled order returns its stock. Also leaves a tombstone if it arrives first. */
  async function onOrderCancelled(event: DomainEvent) {
    const { orderId } = event.data as { orderId: string };
    const before = await Reservation.findOneAndUpdate(
      { orderId },
      { $set: { status: 'CANCELLED' }, $setOnInsert: { orderId } },
      { upsert: true, returnDocument: 'before' },
    );
    await releaseHolds(orderId);
    if (before && before.status !== 'CANCELLED') {
      await publish(InventoryEvents.released, { orderId }, event);
    }
  }

  const serialize = (p: InstanceType<typeof Product>) => ({
    sku: p.sku,
    name: p.name,
    priceCents: p.priceCents,
    stock: p.stock,
  });

  const router = Router();
  router.get('/health', (_req, res) => {
    const up = connection.readyState === 1;
    res.status(up ? 200 : 503).json({ service: SERVICE, status: up ? 'ok' : 'degraded' });
  });
  router.get('/products', async (_req, res) => {
    const products = await Product.find().sort({ sku: 1 });
    res.json({ data: products.map(serialize) });
  });
  router.get('/products/:sku', async (req, res) => {
    const product = await Product.findOne({ sku: String(req.params.sku).toUpperCase() });
    if (!product) throw NotFound('Product');
    res.json({ product: serialize(product) });
  });

  const app = createBaseApp(logger);
  app.use(router);
  finalizeApp(app, logger);

  return {
    app,
    Product,
    Reservation,
    async start() {
      if (seedCatalog && (await Product.estimatedDocumentCount()) === 0) {
        await Product.insertMany(DEMO_CATALOG);
        logger.info({ products: DEMO_CATALOG.length }, 'seeded demo catalog');
      }
      await bus.subscribe(
        SERVICE,
        ['order.created', 'order.cancelled'],
        idempotent(connection, SERVICE, async (e) => {
          if (e.type === 'order.created') await onOrderCreated(e);
          else await onOrderCancelled(e);
        }),
      );
    },
    async stop() {},
  };
}
