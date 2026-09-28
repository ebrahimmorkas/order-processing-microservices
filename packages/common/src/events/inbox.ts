import { Schema, type Connection } from 'mongoose';
import type { DomainEvent, EventHandler } from './types.js';

/**
 * Idempotent consumer ("inbox") pattern. Delivery is at-least-once, so a
 * handler may see the same event twice (retries, redelivery after a crash).
 * Processed event ids are recorded in the service's own database and repeats
 * are skipped.
 *
 * The id is recorded after the handler succeeds, so handlers should also make
 * their writes conditional (e.g. only transition from PENDING) to stay safe if
 * the process dies between the two steps.
 */
export function idempotent(connection: Connection, consumer: string, handler: EventHandler) {
  const Processed =
    connection.models.ProcessedEvent ??
    connection.model(
      'ProcessedEvent',
      new Schema(
        { _id: String, consumer: String, type: String },
        { timestamps: { createdAt: true, updatedAt: false } },
      ),
      'processed_events',
    );

  return async (event: DomainEvent) => {
    const key = `${consumer}:${event.id}`;
    if (await Processed.exists({ _id: key })) return;
    await handler(event);
    await Processed.updateOne(
      { _id: key },
      { $setOnInsert: { consumer, type: event.type } },
      { upsert: true },
    );
  };
}
