/**
 * Small shims so the minigame engine (kept as plain JavaScript) can use the
 * server's pino logger and id helper without depending on the old layout.
 */
import { randomInt } from 'node:crypto';
import { logger as pino } from '../logger.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const generateId = (length = 16) => {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
};

// The engine logs as logger.level(message, meta); pino wants (meta, message).
const wrap = (level) => (message, meta) => {
  if (meta && typeof meta === 'object') pino[level](meta, String(message));
  else pino[level](String(message));
};

export const logger = {
  trace: wrap('trace'),
  debug: wrap('debug'),
  info: wrap('info'),
  warn: wrap('warn'),
  error: wrap('error'),
};
