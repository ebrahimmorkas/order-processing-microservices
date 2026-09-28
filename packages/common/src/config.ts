import 'dotenv/config';
import { z } from 'zod';

export const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** Settings every service shares. Each service extends this with its own. */
export const baseConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** `mongo` needs no extra infrastructure; `rabbitmq` uses RABBITMQ_URL. */
  EVENT_BUS: z.enum(['mongo', 'rabbitmq']).default('mongo'),
  EVENT_STORE_URL: z.string().default('mongodb://localhost:27017/ops_events'),
  RABBITMQ_URL: z.string().default('amqp://guest:guest@localhost:5672'),
});

/**
 * Validates `source` (process.env by default) against a schema and returns
 * typed config, failing fast with a readable message.
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  source: Record<string, unknown> = process.env,
): z.infer<S> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
