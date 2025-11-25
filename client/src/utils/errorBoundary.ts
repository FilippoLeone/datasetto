/**
 * Error boundary utilities for graceful error handling
 * Since we're using vanilla TypeScript (no React), this provides
 * similar protection through wrapper functions and error handlers
 */

import { createLogger } from './logger';

const logger = createLogger('ErrorBoundary');

export interface ErrorInfo {
  componentName?: string;
  operation?: string;
  timestamp: number;
  error: Error;
  stack?: string;
  context?: Record<string, unknown>;
}

type ErrorHandler = (errorInfo: ErrorInfo) => void;

const errorHandlers: Set<ErrorHandler> = new Set();
const errorHistory: ErrorInfo[] = [];
const MAX_ERROR_HISTORY = 50;

/**
 * Register a global error handler
 */
export function registerErrorHandler(handler: ErrorHandler): () => void {
  errorHandlers.add(handler);
  return () => errorHandlers.delete(handler);
}

/**
 * Report an error to all registered handlers
 */
export function reportError(
  error: Error,
  context?: { componentName?: string; operation?: string; extra?: Record<string, unknown> }
): void {
  const errorInfo: ErrorInfo = {
    componentName: context?.componentName,
    operation: context?.operation,
    timestamp: Date.now(),
    error,
    stack: error.stack,
    context: context?.extra,
  };

  // Log the error
  logger.error(`${context?.componentName ?? 'Unknown'}: ${error.message}`, {
    operation: context?.operation,
    stack: error.stack,
    ...context?.extra,
  });

  // Add to history
  errorHistory.push(errorInfo);
  if (errorHistory.length > MAX_ERROR_HISTORY) {
    errorHistory.shift();
  }

  // Notify handlers
  errorHandlers.forEach(handler => {
    try {
      handler(errorInfo);
    } catch (handlerError) {
      console.error('[ErrorBoundary] Error in error handler:', handlerError);
    }
  });
}

/**
 * Get error history for debugging
 */
export function getErrorHistory(): ReadonlyArray<ErrorInfo> {
  return [...errorHistory];
}

/**
 * Clear error history
 */
export function clearErrorHistory(): void {
  errorHistory.length = 0;
}

/**
 * Wrap a function with error handling
 * Catches errors and reports them, optionally returning a fallback value
 */
export function withErrorBoundary<T extends (...args: unknown[]) => unknown>(
  fn: T,
  options: {
    componentName?: string;
    operation?: string;
    fallback?: ReturnType<T>;
    rethrow?: boolean;
  } = {}
): T {
  const wrapped = ((...args: Parameters<T>): ReturnType<T> | undefined => {
    try {
      return fn(...args) as ReturnType<T>;
    } catch (error) {
      reportError(error instanceof Error ? error : new Error(String(error)), {
        componentName: options.componentName,
        operation: options.operation,
      });

      if (options.rethrow) {
        throw error;
      }

      return options.fallback;
    }
  }) as T;

  return wrapped;
}

/**
 * Wrap an async function with error handling
 */
export function withAsyncErrorBoundary<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: {
    componentName?: string;
    operation?: string;
    fallback?: Awaited<ReturnType<T>>;
    rethrow?: boolean;
  } = {}
): T {
  const wrapped = (async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>> | undefined> => {
    try {
      return await fn(...args) as Awaited<ReturnType<T>>;
    } catch (error) {
      reportError(error instanceof Error ? error : new Error(String(error)), {
        componentName: options.componentName,
        operation: options.operation,
      });

      if (options.rethrow) {
        throw error;
      }

      return options.fallback;
    }
  }) as T;

  return wrapped;
}

/**
 * Safely execute a function, catching and reporting any errors
 */
export function safeExecute<T>(
  fn: () => T,
  options: {
    componentName?: string;
    operation?: string;
    fallback?: T;
  } = {}
): T | undefined {
  try {
    return fn();
  } catch (error) {
    reportError(error instanceof Error ? error : new Error(String(error)), {
      componentName: options.componentName,
      operation: options.operation,
    });
    return options.fallback;
  }
}

/**
 * Safely execute an async function, catching and reporting any errors
 */
export async function safeExecuteAsync<T>(
  fn: () => Promise<T>,
  options: {
    componentName?: string;
    operation?: string;
    fallback?: T;
  } = {}
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    reportError(error instanceof Error ? error : new Error(String(error)), {
      componentName: options.componentName,
      operation: options.operation,
    });
    return options.fallback;
  }
}

/**
 * Create a protected DOM element updater that won't throw on errors
 */
export function createSafeUpdater(
  element: HTMLElement | null,
  componentName: string
): {
  setText: (text: string) => void;
  setHtml: (html: string) => void;
  addClass: (...classes: string[]) => void;
  removeClass: (...classes: string[]) => void;
  toggleClass: (className: string, force?: boolean) => void;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  show: () => void;
  hide: () => void;
} {
  const safe = <T>(operation: string, fn: () => T, fallback?: T): T | undefined => {
    if (!element) {
      logger.warn(`${componentName}: Element not found for operation "${operation}"`);
      return fallback;
    }
    return safeExecute(fn, { componentName, operation, fallback });
  };

  return {
    setText: (text: string) => safe('setText', () => { element!.textContent = text; }),
    setHtml: (html: string) => safe('setHtml', () => { element!.innerHTML = html; }),
    addClass: (...classes: string[]) => safe('addClass', () => { element!.classList.add(...classes); }),
    removeClass: (...classes: string[]) => safe('removeClass', () => { element!.classList.remove(...classes); }),
    toggleClass: (className: string, force?: boolean) => safe('toggleClass', () => { element!.classList.toggle(className, force); }),
    setAttribute: (name: string, value: string) => safe('setAttribute', () => { element!.setAttribute(name, value); }),
    removeAttribute: (name: string) => safe('removeAttribute', () => { element!.removeAttribute(name); }),
    show: () => safe('show', () => { element!.classList.remove('hidden'); }),
    hide: () => safe('hide', () => { element!.classList.add('hidden'); }),
  };
}

/**
 * Setup global error handlers for uncaught errors
 */
export function setupGlobalErrorHandlers(): () => void {
  const handleError = (event: ErrorEvent) => {
    reportError(event.error ?? new Error(event.message), {
      componentName: 'Window',
      operation: 'uncaughtError',
      extra: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    });
  };

  const handleRejection = (event: PromiseRejectionEvent) => {
    const error = event.reason instanceof Error
      ? event.reason
      : new Error(String(event.reason));

    reportError(error, {
      componentName: 'Window',
      operation: 'unhandledRejection',
    });
  };

  window.addEventListener('error', handleError);
  window.addEventListener('unhandledrejection', handleRejection);

  return () => {
    window.removeEventListener('error', handleError);
    window.removeEventListener('unhandledrejection', handleRejection);
  };
}

// Expose debugging helpers
if (typeof window !== 'undefined') {
  (window as typeof window & { __datasettoErrors?: unknown }).__datasettoErrors = {
    getHistory: getErrorHistory,
    clearHistory: clearErrorHistory,
  };
}
