import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  base: { app: 'temur-fit-bot' },
  redact: {
    paths: ['*.token', '*.apiKey', '*.business_connection_id', '*.businessConnectionId', 'text', '*.text'],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
