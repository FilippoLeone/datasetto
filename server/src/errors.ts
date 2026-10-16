/**
 * Error type carrying a stable machine-readable code and an HTTP-ish status.
 * Socket handlers forward `message` and `code` to the client; HTTP routes map
 * `status` to the response.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'ERROR', status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;

export const errorMessage = (error: unknown, fallback = 'Unexpected error'): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
};

export const notAuthenticated = (): AppError => new AppError('Not authenticated', 'NOT_AUTHENTICATED', 401);
export const forbidden = (message = 'Not allowed'): AppError => new AppError(message, 'FORBIDDEN', 403);
export const notFound = (what = 'Resource'): AppError => new AppError(`${what} not found`, 'NOT_FOUND', 404);
