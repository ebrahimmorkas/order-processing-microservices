import type { DomainEvent, EventBus, Logger } from '@ops/common';
import type { OrderModel } from './order.model.js';

/**
 * Publishes events stored in order outboxes, then removes them.
 *
 * Delivery is at-least-once: if the process dies after publishing but before
 * `$pull`, the event is published again on restart; consumers deduplicate by
 * event id. The relay polls periodically and can be `kick()`ed right after a
 * write for low latency.
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly orders: OrderModel,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly intervalMs = 500,
  ) {}

  start() {
    this.stopped = false;
    this.schedule();
  }

  /** Requests an immediate run (coalesced if one is already in progress). */
  kick() {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.runOnce()
      .catch((err) => this.logger.error({ err }, 'outbox relay failed'))
      .finally(() => {
        this.running = undefined;
        if (this.rerun) {
          this.rerun = false;
          this.kick();
        }
      });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule() {
    this.timer = setTimeout(() => {
      this.kick();
      if (!this.stopped) this.schedule();
    }, this.intervalMs);
  }

  private async runOnce() {
    const pending = await this.orders
      .find({ 'outbox.0': { $exists: true } }, { outbox: 1 })
      .limit(100)
      .lean();
    for (const order of pending) {
      for (const event of order.outbox as DomainEvent[]) {
        await this.bus.publish(event);
        await this.orders.updateOne({ _id: order._id }, { $pull: { outbox: { id: event.id } } });
      }
    }
  }
}
