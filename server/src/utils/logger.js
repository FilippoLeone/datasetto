/**
 * Logger Utility
 * Centralized logging with different levels and formats
 */

import { appConfig } from '../config/index.js';

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const levelColors = {
  error: colors.red,
  warn: colors.yellow,
  info: colors.blue,
  debug: colors.cyan,
  trace: colors.magenta,
};

const levelPriorities = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

class Logger {
  constructor() {
    this.level = appConfig.logging.level;
    this.levelPriority = levelPriorities[this.level] || 2;
  }

  /**
   * Format log message
   */
  formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const color = levelColors[level] || colors.white;
    const levelStr = level.toUpperCase().padEnd(5);

    if (appConfig.logging.format === 'json') {
      return JSON.stringify({
        timestamp,
        level: level.toUpperCase(),
        message,
        ...meta,
      });
    }

    // Pretty format for development
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${colors.dim}${timestamp}${colors.reset} ${color}${levelStr}${colors.reset} ${message}${metaStr}`;
  }

  /**
   * Check if level should be logged
   */
  shouldLog(level) {
    const priority = levelPriorities[level] || 2;
    return priority <= this.levelPriority;
  }

  /**
   * Log error message
   */
  error(message, meta = {}) {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, meta));
    }
  }

  /**
   * Log warning message
   */
  warn(message, meta = {}) {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, meta));
    }
  }

  /**
   * Log info message
   */
  info(message, meta = {}) {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, meta));
    }
  }

  /**
   * Log debug message
   */
  debug(message, meta = {}) {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, meta));
    }
  }

  /**
   * Log trace message (very verbose)
   */
  trace(message, meta = {}) {
    if (this.shouldLog('trace')) {
      console.log(this.formatMessage('trace', message, meta));
    }
  }

  /**
   * Log HTTP request
   */
  http(method, path, statusCode, responseTime) {
    const color = statusCode >= 500 ? colors.red :
                  statusCode >= 400 ? colors.yellow :
                  statusCode >= 300 ? colors.cyan :
                  colors.green;

    const message = `${method.padEnd(6)} ${path.padEnd(30)} ${color}${statusCode}${colors.reset} ${responseTime}ms`;
    this.info(message);
  }

  /**
   * Log socket event
   */
  socket(event, socketId, data = {}) {
    this.debug(`Socket ${event}`, { socketId, ...data });
  }

  /**
   * Set log level dynamically
   */
  setLevel(level) {
    if (levelPriorities[level] !== undefined) {
      this.level = level;
      this.levelPriority = levelPriorities[level];
      this.info(`Log level set to ${level.toUpperCase()}`);
    }
  }
}

// Create singleton instance
const logger = new Logger();

export default logger;
