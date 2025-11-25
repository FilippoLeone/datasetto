/**
 * Client-side logger with configurable levels and production-safe behavior
 * 
 * In development: All logs are shown
 * In production: Only warn/error are shown by default, can be enabled via localStorage
 */

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  context: string;
  message: string;
  data?: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const STORAGE_KEY = 'datasetto.logLevel';
const MAX_LOG_HISTORY = 100;

class Logger {
  private context: string;
  private static logHistory: LogEntry[] = [];
  private static minLevel: LogLevel = 'warn';
  private static initialized = false;

  constructor(context: string) {
    this.context = context;
    if (!Logger.initialized) {
      Logger.initialize();
    }
  }

  private static initialize(): void {
    Logger.initialized = true;
    
    // In development, show all logs
    if (import.meta.env.DEV) {
      Logger.minLevel = 'debug';
      return;
    }

    // In production, check localStorage for debug override
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && stored in LOG_LEVELS) {
        Logger.minLevel = stored as LogLevel;
      }
    } catch {
      // localStorage not available
    }

    // Expose helper on window for debugging production issues
    if (typeof window !== 'undefined') {
      (window as typeof window & { __datasettoDebug?: unknown }).__datasettoDebug = {
        setLogLevel: (level: LogLevel) => {
          if (level in LOG_LEVELS) {
            Logger.minLevel = level;
            try {
              localStorage.setItem(STORAGE_KEY, level);
            } catch {
              // ignore
            }
            console.log(`[Datasetto] Log level set to: ${level}`);
          }
        },
        getLogHistory: () => [...Logger.logHistory],
        clearLogHistory: () => {
          Logger.logHistory = [];
          console.log('[Datasetto] Log history cleared');
        },
      };
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[Logger.minLevel];
  }

  private addToHistory(entry: LogEntry): void {
    Logger.logHistory.push(entry);
    if (Logger.logHistory.length > MAX_LOG_HISTORY) {
      Logger.logHistory.shift();
    }
  }

  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString().slice(11, 23);
    return `[${timestamp}] [${level.toUpperCase().padEnd(5)}] [${this.context}] ${message}`;
  }

  trace(message: string, data?: unknown): void {
    this.log('trace', message, data);
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      context: this.context,
      message,
      data,
    };

    // Always add to history for debugging
    this.addToHistory(entry);

    if (!this.shouldLog(level)) {
      return;
    }

    const formatted = this.formatMessage(level, message);
    const consoleMethod = level === 'trace' ? 'log' : level;

    if (data !== undefined) {
      console[consoleMethod](formatted, data);
    } else {
      console[consoleMethod](formatted);
    }
  }

  /**
   * Create a child logger with a sub-context
   */
  child(subContext: string): Logger {
    return new Logger(`${this.context}:${subContext}`);
  }

  /**
   * Time an operation and log its duration
   */
  time<T>(label: string, fn: () => T): T {
    const start = performance.now();
    try {
      const result = fn();
      const duration = performance.now() - start;
      this.debug(`${label} completed in ${duration.toFixed(2)}ms`);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.error(`${label} failed after ${duration.toFixed(2)}ms`, error);
      throw error;
    }
  }

  /**
   * Time an async operation and log its duration
   */
  async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      const duration = performance.now() - start;
      this.debug(`${label} completed in ${duration.toFixed(2)}ms`);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.error(`${label} failed after ${duration.toFixed(2)}ms`, error);
      throw error;
    }
  }
}

/**
 * Create a logger instance for a specific context
 */
export function createLogger(context: string): Logger {
  return new Logger(context);
}

/**
 * Default logger for general use
 */
export const logger = createLogger('App');
