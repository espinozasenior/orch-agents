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

// ---------------------------------------------------------------------------
// Error sanitization utilities for safe external display
// ---------------------------------------------------------------------------

/**
 * Returns a truncated stack trace with at most `maxFrames` lines after the
 * message line. Prevents leaking deep internal paths in external-facing
 * error messages.
 */
export function shortErrorStack(error: Error, maxFrames = 5): string {
  const stack = error.stack;
  if (!stack) return error.message;

  const lines = stack.split('\n');
  // First line(s) are the message; frame lines start with whitespace + "at "
  const messageLines: string[] = [];
  const frameLines: string[] = [];

  for (const line of lines) {
    if (frameLines.length === 0 && !/^\s+at /.test(line)) {
      messageLines.push(line);
    } else {
      frameLines.push(line);
    }
  }

  return [...messageLines, ...frameLines.slice(0, maxFrames)].join('\n');
}

/**
 * General-purpose secret redaction for any text. Replaces known token
 * patterns with safe placeholders.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/ghp_[A-Za-z0-9]{36}/g, 'ghp_***')
    .replace(/ghs_[A-Za-z0-9]{36}/g, 'ghs_***')
    .replace(/xoxb-[A-Za-z0-9-]+/g, 'xoxb-***')
    .replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer ***')
    .replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}

/** Replace absolute filesystem paths with their relative tail. */
function sanitizePaths(text: string): string {
  // Match absolute paths on Unix and Windows, capture the relative portion
  // starting with a known project directory prefix (src/, tests/, config/, etc.)
  // or fall back to just the basename.
  return text.replace(
    /(?:\/(?:Users|home|tmp|var|opt|private)\/[^\s:,)]+|[A-Z]:\\[^\s:,)]+)/g,
    (match: string) => {
      // Try to keep a relative portion starting with a well-known directory
      const relativeMatch = match.match(
        /[/\\]((?:src|tests|config|scripts|docs|data|node_modules)[/\\].*)$/,
      );
      if (relativeMatch) return relativeMatch[1];

      // Fall back to filename only
      const parts = match.split(/[/\\]/);
      return parts[parts.length - 1];
    },
  );
}

/** Strip env-var-style KEY=value pairs. */
function stripEnvValues(text: string): string {
  // Match UPPER_SNAKE_CASE=<non-whitespace value> but not inside URLs
  return text.replace(/\b([A-Z][A-Z0-9_]{2,})=[^\s]+/g, '$1=***');
}

/** Strip long hex/base64 tokens that look like secrets. */
function stripTokenLikeStrings(text: string): string {
  // Hex strings > 32 chars
  let result = text.replace(/\b[0-9a-fA-F]{33,}\b/g, '***');
  // Base64-ish strings > 40 chars preceded by common prefixes
  result = result.replace(
    /(token:|key:|secret:|password:|authorization:)\s*[A-Za-z0-9+/=]{40,}/gi,
    '$1 ***',
  );
  return result;
}

/**
 * Returns a safe error string suitable for posting to Linear comments,
 * GitHub PR comments, or any external API. Strips absolute paths,
 * environment variable values, and secret-like tokens.
 */
export function sanitizeForExternalDisplay(error: Error): string {
  let message = error.message;
  message = sanitizePaths(message);
  message = stripEnvValues(message);
  message = stripTokenLikeStrings(message);
  message = redactSecrets(message);

  let stack = shortErrorStack(error, 3);
  stack = sanitizePaths(stack);
  stack = stripEnvValues(stack);
  stack = stripTokenLikeStrings(stack);
  stack = redactSecrets(stack);

  // Avoid duplicating the message if the stack already starts with it
  if (stack.startsWith(message)) {
    return stack;
  }
  return `${message}\n${stack}`;
}

