import type { Connection } from 'mongoose';
import { Schema } from 'mongoose';
import { connectMongo } from '../db.js';
import type { Logger } from '../logger.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  type DomainEvent,
  type EventBus,
  type EventHandler,
  type SubscribeOptions,
} from './types.js';

interface Delivery {
  consumer: string;
  event: DomainEvent;
  status: 'pending' | 'processing' | 'dead';
  attempts: number;
  availableAt: Date;
  lockedUntil: Date | null;
  lastError: string | null;
}

export interface MongoEventBusOptions {
  pollIntervalMs?: number;
  /** A claimed message becomes visible again if not finished within this time. */
  lockMs?: number;
  /** Base delay for exponential retry backoff. */
  backoffBaseMs?: number;
}

function buildModels(connection: Connection) {
  const deliverySchema = new Schema<Delivery>(
    {
      consumer: { type: String, required: true },
      event: { type: Schema.Types.Mixed, required: true },
      status: { type: String, enum: ['pending', 'processing', 'dead'], default: 'pending' },
      attempts: { type: Number, default: 0 },
      availableAt: { type: Date, default: () => new Date() },
      lockedUntil: { type: Date, default: null },
      lastError: { type: String, default: null },
    },
    { timestamps: true },
  );
  deliverySchema.index({ consumer: 1, status: 1, availableAt: 1 });

  return {
    deliveries: connection.model('Delivery', deliverySchema, 'deliveries'),
    subscriptions: connection.model(
      'Subscription',
      new Schema({ _id: String, types: [String] }, { timestamps: true }),
      'subscriptions',
    ),
    // Append-only log of everything published (audit/debugging).
    events: connection.model(
      'EventLog',
      new Schema(
        { event: Schema.Types.Mixed },
        { timestamps: { createdAt: true, updatedAt: false } },
      ),
      'events',
    ),
  };
}

type Models = ReturnType<typeof buildModels>;

/**
 * Event bus backed by MongoDB, so the system runs without a message broker.
 *
 * - Every subscriber (consumer name) is registered in `subscriptions`.
 * - `publish` fans an event out into one `deliveries` document per interested consumer.
 * - Workers claim deliveries with an atomic `findOneAndUpdate`, so competing
 *   instances never process the same delivery concurrently.
 * - Failures are retried with exponential backoff; after `maxAttempts` the
 *   delivery is marked `dead` (dead-letter).
 * - A crashed worker's claim expires after `lockMs` and the delivery is retried.
 */
export class MongoEventBus implements EventBus {
  readonly kind = 'mongo' as const;
  private readonly deliveries!: Models['deliveries'];
  private readonly subscriptions!: Models['subscriptions'];
  private readonly events!: Models['events'];
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  private constructor(
    private readonly connection: Connection,
    private readonly logger: Logger,
    private readonly options: Required<MongoEventBusOptions>,
  ) {
    ({
      deliveries: this.deliveries,
      subscriptions: this.subscriptions,
      events: this.events,
    } = buildModels(connection));
  }

  static async connect(url: string, logger: Logger, options: MongoEventBusOptions = {}) {
    const connection = await connectMongo(url);
    return new MongoEventBus(connection, logger, {
      pollIntervalMs: options.pollIntervalMs ?? 200,
      lockMs: options.lockMs ?? 30_000,
      backoffBaseMs: options.backoffBaseMs ?? 500,
    });
  }

  async publish(event: DomainEvent): Promise<void> {
    const subscribers = await this.subscriptions.find({ types: event.type }, { _id: 1 }).lean();
    await this.events.create({ event });
    if (subscribers.length === 0) return;
    await this.deliveries.insertMany(
      subscribers.map((s) => ({ consumer: s._id, event, availableAt: new Date() })),
    );
  }

  async subscribe(
    consumer: string,
    types: string[],
    handler: EventHandler,
    options: SubscribeOptions = {},
  ): Promise<void> {
    await this.subscriptions.updateOne(
      { _id: consumer },
      { $addToSet: { types: { $each: types } } },
      { upsert: true },
    );
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    const tick = async () => {
      if (this.closed) return;
      const work = this.drain(consumer, handler, maxAttempts).catch((err) =>
        this.logger.error({ err, consumer }, 'event polling failed'),
      );
      this.inFlight.add(work);
      await work;
      this.inFlight.delete(work);
      if (!this.closed) schedule();
    };
    const schedule = () => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void tick();
      }, this.options.pollIntervalMs);
      this.timers.add(timer);
    };
    schedule();
  }

  /** Processes deliveries until none are available right now. */
  private async drain(consumer: string, handler: EventHandler, maxAttempts: number) {
    while (!this.closed) {
      const now = new Date();
      const delivery = await this.deliveries.findOneAndUpdate(
        {
          consumer,
          $or: [
            { status: 'pending', availableAt: { $lte: now } },
            { status: 'processing', lockedUntil: { $lt: now } },
          ],
        },
        {
          $set: {
            status: 'processing',
            lockedUntil: new Date(now.getTime() + this.options.lockMs),
          },
          $inc: { attempts: 1 },
        },
        { sort: { availableAt: 1 }, returnDocument: 'after' },
      );
      if (!delivery) return;

      try {
        await handler(delivery.event);
        await this.deliveries.deleteOne({ _id: delivery._id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (delivery.attempts >= maxAttempts) {
          this.logger.error(
            { consumer, eventId: delivery.event.id, type: delivery.event.type, err },
            'event dead-lettered',
          );
          await this.deliveries.updateOne(
            { _id: delivery._id },
            { $set: { status: 'dead', lastError: message, lockedUntil: null } },
          );
        } else {
          const delay = this.options.backoffBaseMs * 2 ** (delivery.attempts - 1);
          this.logger.warn(
            { consumer, eventId: delivery.event.id, attempt: delivery.attempts, delay },
            'event handler failed; will retry',
          );
          await this.deliveries.updateOne(
            { _id: delivery._id },
            {
              $set: {
                status: 'pending',
                lastError: message,
                lockedUntil: null,
                availableAt: new Date(Date.now() + delay),
              },
            },
          );
        }
      }
    }
  }

  deadLetterCount(consumer: string): Promise<number> {
    return this.deliveries.countDocuments({ consumer, status: 'dead' });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.inFlight]);
    await this.connection.close();
  }
}
