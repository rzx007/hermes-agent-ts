import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(name = 'hermes'): Logger {
  return pino({
    name,
    level: process.env.HERMES_LOG_LEVEL ?? 'info',
    transport: process.env.HERMES_LOG_PRETTY
      ? { target: 'pino-pretty' }
      : undefined,
  });
}
