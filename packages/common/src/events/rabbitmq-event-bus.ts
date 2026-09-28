import {
  connect,
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from 'amqplib';
import type { Logger } from '../logger.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  type DomainEvent,
  type EventBus,
  type EventHandler,
  type SubscribeOptions,
} from './types.js';

const EXCHANGE = 'ops.events';
const DEAD_LETTER_EXCHANGE = 'ops.events.dlx';
const ATTEMPTS_HEADER = 'x-attempts';

export interface RabbitMqEventBusOptions {
  prefetch?: number;
  backoffBaseMs?: number;
}

/**
 * RabbitMQ implementation.
 *
 * - One durable **topic exchange**; events are routed by type (`order.created`).
 * - One durable **queue per consumer**, bound to the event types it handles:
 *   fan-out across consumers, load-balancing across instances of one consumer.
 * - **Publisher confirms** + persistent messages: `publish` resolves only once
 *   the broker has accepted the message.
 * - Failed messages are re-queued to the consumer's own queue with an attempt
 *   counter and exponential backoff; after `maxAttempts` they are rejected
 *   into `<consumer>.dlq` through a dead-letter exchange.
 */
export class RabbitMqEventBus implements EventBus {
  readonly kind = 'rabbitmq' as const;
  private readonly consumerChannels: Channel[] = [];
  private readonly pendingRetries = new Set<NodeJS.Timeout>();
  private closed = false;

  private constructor(
    private readonly connection: ChannelModel,
    private readonly publishChannel: ConfirmChannel,
    private readonly logger: Logger,
    private readonly options: Required<RabbitMqEventBusOptions>,
  ) {}

  static async connect(url: string, logger: Logger, options: RabbitMqEventBusOptions = {}) {
    const connection = await connect(url);
    connection.on('error', (err) => logger.error({ err }, 'rabbitmq connection error'));
    const channel = await connection.createConfirmChannel();
    await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
    return new RabbitMqEventBus(connection, channel, logger, {
      prefetch: options.prefetch ?? 10,
      backoffBaseMs: options.backoffBaseMs ?? 500,
    });
  }

  async publish(event: DomainEvent): Promise<void> {
    this.publishChannel.publish(EXCHANGE, event.type, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
      messageId: event.id,
      type: event.type,
      correlationId: event.correlationId,
      headers: { [ATTEMPTS_HEADER]: 0 },
    });
    await this.publishChannel.waitForConfirms();
  }

  async subscribe(
    consumer: string,
    types: string[],
    handler: EventHandler,
    options: SubscribeOptions = {},
  ): Promise<void> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const channel = await this.connection.createChannel();
    this.consumerChannels.push(channel);
    await channel.prefetch(this.options.prefetch);

    const dlq = `${consumer}.dlq`;
    await channel.assertQueue(dlq, { durable: true });
    await channel.bindQueue(dlq, DEAD_LETTER_EXCHANGE, consumer);
    await channel.assertQueue(consumer, {
      durable: true,
      deadLetterExchange: DEAD_LETTER_EXCHANGE,
      deadLetterRoutingKey: consumer,
    });
    for (const type of types) await channel.bindQueue(consumer, EXCHANGE, type);

    await channel.consume(consumer, (msg) => {
      if (msg) void this.handle(channel, consumer, msg, handler, maxAttempts);
    });
  }

  /**
   * Runs a channel operation unless the bus is shutting down. After close, the
   * broker redelivers any unacknowledged message, so skipping is safe.
   */
  private safely(action: () => void) {
    if (this.closed) return;
    try {
      action();
    } catch (err) {
      this.logger.warn({ err }, 'channel operation skipped (channel closed)');
    }
  }

  private async handle(
    channel: Channel,
    consumer: string,
    msg: ConsumeMessage,
    handler: EventHandler,
    maxAttempts: number,
  ) {
    const attempts = Number(msg.properties.headers?.[ATTEMPTS_HEADER] ?? 0) + 1;
    let event: DomainEvent;
    try {
      event = JSON.parse(msg.content.toString()) as DomainEvent;
    } catch {
      this.logger.error({ consumer }, 'unparseable message dead-lettered');
      this.safely(() => channel.nack(msg, false, false));
      return;
    }

    try {
      await handler(event);
      this.safely(() => channel.ack(msg));
    } catch (err) {
      if (attempts >= maxAttempts) {
        this.logger.error({ consumer, eventId: event.id, err }, 'event dead-lettered');
        this.safely(() => channel.nack(msg, false, false));
        return;
      }
      if (this.closed) return; // unacked: the broker will redeliver it
      const delay = this.options.backoffBaseMs * 2 ** (attempts - 1);
      this.logger.warn({ consumer, eventId: event.id, attempt: attempts, delay }, 'retrying event');
      const timer = setTimeout(() => {
        this.pendingRetries.delete(timer);
        this.safely(() => {
          // Re-queue to this consumer only (not the exchange) so other consumers aren't affected.
          channel.sendToQueue(consumer, msg.content, {
            ...msg.properties,
            headers: { ...msg.properties.headers, [ATTEMPTS_HEADER]: attempts },
          });
          channel.ack(msg);
        });
      }, delay);
      this.pendingRetries.add(timer);
    }
  }

  async deadLetterCount(consumer: string): Promise<number> {
    const { messageCount } = await this.publishChannel.checkQueue(`${consumer}.dlq`);
    return messageCount;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.pendingRetries) clearTimeout(timer);
    await Promise.allSettled(this.consumerChannels.map((c) => c.close()));
    await this.publishChannel.close().catch(() => undefined);
    await this.connection.close().catch(() => undefined);
  }
}
