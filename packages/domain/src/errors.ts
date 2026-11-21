export type ErrorCode =
  | 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT'
  | 'LIMIT_EXCEEDED' | 'RATE_LIMITED' | 'UNSAFE_URL' | 'INVALID_SPEC' | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
  LIMIT_EXCEEDED: 402, RATE_LIMITED: 429, UNSAFE_URL: 400, INVALID_SPEC: 422, INTERNAL: 500,
};

/** Domain error with a stable machine-readable code. HTTP adapters map it via `status`. */
export class AppError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}
export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
