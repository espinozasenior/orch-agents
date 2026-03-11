/**
 * Custom error hierarchy for the Orch-Agents system.
 *
 * All application errors extend AppError, which provides:
 * - Structured error codes for programmatic handling
 * - HTTP status code mapping (for API boundary)
 * - Optional cause chaining (Error.cause)
 */

// ---------------------------------------------------------------------------
// Base application error
// ---------------------------------------------------------------------------

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    options: {
      code?: string;
      statusCode?: number;
      isOperational?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code ?? 'ERR_INTERNAL';
    this.statusCode = options.statusCode ?? 500;
    this.isOperational = options.isOperational ?? true;
  }
}

// ---------------------------------------------------------------------------
// Validation errors (400-level)
// ---------------------------------------------------------------------------

export class ValidationError extends AppError {
  public readonly fields: Record<string, string>;

  constructor(
    message: string,
    fields: Record<string, string> = {},
    options: { cause?: unknown } = {},
  ) {
    super(message, {
      code: 'ERR_VALIDATION',
      statusCode: 400,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

// ---------------------------------------------------------------------------
// Authentication / Authorization errors
// ---------------------------------------------------------------------------

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', options: { cause?: unknown } = {}) {
    super(message, {
      code: 'ERR_AUTHENTICATION',
      statusCode: 401,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Forbidden', options: { cause?: unknown } = {}) {
    super(message, {
      code: 'ERR_AUTHORIZATION',
      statusCode: 403,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'AuthorizationError';
  }
}

// ---------------------------------------------------------------------------
// Not-found error
// ---------------------------------------------------------------------------

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string, options: { cause?: unknown } = {}) {
    const msg = id ? `${resource} '${id}' not found` : `${resource} not found`;
    super(msg, {
      code: 'ERR_NOT_FOUND',
      statusCode: 404,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'NotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Conflict error (duplicate delivery, idempotency)
// ---------------------------------------------------------------------------

export class ConflictError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      code: 'ERR_CONFLICT',
      statusCode: 409,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'ConflictError';
  }
}

// ---------------------------------------------------------------------------
// Rate limit error
// ---------------------------------------------------------------------------

export class RateLimitError extends AppError {
  public readonly retryAfter: number;

  constructor(retryAfter: number, options: { cause?: unknown } = {}) {
    super(`Rate limited. Retry after ${retryAfter}s`, {
      code: 'ERR_RATE_LIMIT',
      statusCode: 429,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

// ---------------------------------------------------------------------------
// Domain-specific errors
// ---------------------------------------------------------------------------

export class TriageError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      code: 'ERR_TRIAGE',
      statusCode: 500,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'TriageError';
  }
}

export class PlanningError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      code: 'ERR_PLANNING',
      statusCode: 500,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'PlanningError';
  }
}

export class ExecutionError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      code: 'ERR_EXECUTION',
      statusCode: 500,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'ExecutionError';
  }
}

export class ReviewError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      code: 'ERR_REVIEW',
      statusCode: 500,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'ReviewError';
  }
}

export class DeploymentError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      code: 'ERR_DEPLOYMENT',
      statusCode: 500,
      isOperational: true,
      cause: options.cause,
    });
    this.name = 'DeploymentError';
  }
}
