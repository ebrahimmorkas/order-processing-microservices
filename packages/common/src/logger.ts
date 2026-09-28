import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  const env = process.env.NODE_ENV;
  return pino({
    name: service,
    level: env === 'test' ? 'silent' : level,
    base: { service },
    redact: ['req.headers.authorization', '*.password', '*.passwordHash'],
    ...(env === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
      },
    }),
  });
}
