import type { Logger } from '@ops/common';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Port for outgoing email; swap in an SMTP/SES/SendGrid adapter in production. */
export interface EmailSender {
  send(email: Email): Promise<void>;
}

/** Development adapter: writes emails to the log instead of sending them. */
export class LogEmailSender implements EmailSender {
  constructor(private readonly logger: Logger) {}

  async send(email: Email): Promise<void> {
    this.logger.info({ email }, 'email sent (log transport)');
  }
}

/** Test adapter that records emails in memory. */
export class InMemoryEmailSender implements EmailSender {
  readonly sent: Email[] = [];

  async send(email: Email): Promise<void> {
    this.sent.push(email);
  }
}
