export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = 'ERROR',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const BadRequest = (message = 'Bad request', details?: unknown) =>
  new AppError(400, message, 'BAD_REQUEST', details);
export const Unauthorized = (message = 'Unauthorized') =>
  new AppError(401, message, 'UNAUTHORIZED');
export const Forbidden = (message = 'Forbidden') => new AppError(403, message, 'FORBIDDEN');
export const NotFound = (resource = 'Resource') =>
  new AppError(404, `${resource} not found`, 'NOT_FOUND');
export const Conflict = (message = 'Conflict', code = 'CONFLICT') =>
  new AppError(409, message, code);
