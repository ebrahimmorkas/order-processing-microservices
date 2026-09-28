import { randomUUID } from 'node:crypto';

export interface DomainEvent<T = unknown> {
  /** Unique id; consumers use it for idempotency. */
  id: string;
  /** Routing key, e.g. `order.created`. */
  type: string;
  /** Service that emitted the event. */
  source: string;
  occurredAt: string;
  /** Ties together every event caused by the same user request (tracing). */
  correlationId: string;
  data: T;
}

export type EventHandler = (event: DomainEvent) => Promise<void>;

export interface SubscribeOptions {
  /** Attempts before the message is dead-lettered. */
  maxAttempts?: number;
}

/**
 * At-least-once delivery. Each `consumer` name gets its own queue: every
 * consumer receives every matching event (fan-out), while multiple instances
 * of the same consumer compete for messages (load balancing).
 */
export interface EventBus {
  readonly kind: 'mongo' | 'rabbitmq';
  publish(event: DomainEvent): Promise<void>;
  subscribe(
    consumer: string,
    types: string[],
    handler: EventHandler,
    options?: SubscribeOptions,
  ): Promise<void>;
  /** Messages that exhausted their retries, for monitoring. */
  deadLetterCount(consumer: string): Promise<number>;
  close(): Promise<void>;
}

export function createEvent<T>(
  type: string,
  data: T,
  meta: { source: string; correlationId?: string },
): DomainEvent<T> {
  return {
    id: randomUUID(),
    type,
    source: meta.source,
    occurredAt: new Date().toISOString(),
    correlationId: meta.correlationId ?? randomUUID(),
    data,
  };
}

export const DEFAULT_MAX_ATTEMPTS = 5;
