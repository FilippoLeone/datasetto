import pino from 'pino';

export type Logger = pino.Logger;

const resolveLevel = (): string => {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  if (process.env.NODE_ENV === 'test') return 'silent';
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
};

const usePretty = process.env.NODE_ENV !== 'production' && process.env.LOG_FORMAT !== 'json';

export const logger: Logger = pino({
  level: resolveLevel(),
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['password', '*.password', 'passwordHash', '*.passwordHash', 'token', '*.token', 'streamKey', '*.streamKey'],
    censor: '[redacted]',
  },
  ...(usePretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export default logger;
