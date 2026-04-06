// ---------------------------------------------------------------------------
// P11 — Overload retry with exponential backoff + jitter (FR-P11-004)
// ---------------------------------------------------------------------------
//
// Wraps an arbitrary async producer with retry-on-overloaded semantics.
// Two consumers in this codebase:
//
//   1. queryLoop's `deps.callModel` adapter — wrap to retry the entire
//      streaming call when it throws an overloaded error before yielding.
//   2. sdk-executor's `createQuery` invocation — wrap the SDK stream
//      construction to retry 529s before iteration begins.
//
// Detection rules (matches Anthropic SDK error shapes + CC's heuristic):
//   - HTTP status === 529
//   - error.type === 'overloaded_error'
//   - /overloaded/i.test(error.message)
//
// Backoff sequence: 1s, 2s, 4s, 8s with ±25% jitter, max 4 attempts
// (5 total tries including the first). All matches CC's `query.ts`.
//
// Aborts: a passed AbortSignal cancels any pending backoff timer
// immediately. The throw bubbles as an `AbortError` so callers can
// distinguish from overload exhaustion.

import type { QueryEventEmitter } from './events.js';

export interface OverloadRetryOptions {
  /** Max retries AFTER the first attempt. Default 4 → 5 total tries. */
  readonly maxRetries?: number;
  /** Base delay in ms — first retry waits this long. Default 1000. */
  readonly baseDelayMs?: number;
  /** Max cap for any single backoff. Default 30_000. */
  readonly maxDelayMs?: number;
  /** Jitter ratio (0..1). Default 0.25 → ±25% noise. */
  readonly jitterRatio?: number;
  /** AbortSignal that cancels pending backoff. */
  readonly signal?: AbortSignal;
  /** Optional observability emitter for retry attempts. */
  readonly emit?: QueryEventEmitter;
  /** Optional taskId — propagated into emitted events. */
  readonly taskId?: string;
  /** Injectable RNG for deterministic tests. Default `Math.random`. */
  readonly random?: () => number;
  /** Injectable sleeper for deterministic tests. Default real timer. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_OVERLOAD_MAX_RETRIES = 4;
export const DEFAULT_OVERLOAD_BASE_DELAY_MS = 1000;
export const DEFAULT_OVERLOAD_MAX_DELAY_MS = 30_000;
export const DEFAULT_OVERLOAD_JITTER_RATIO = 0.25;

/** Thrown when retries are exhausted. Carries the last error as `cause`. */
export class OverloadExhaustedError extends Error {
  public readonly attempts: number;
  public readonly lastError: unknown;
  constructor(attempts: number, lastError: unknown) {
    const lastMessage =
      lastError instanceof Error ? lastError.message : String(lastError);
    super(
      `Overloaded API exhausted after ${attempts} attempt(s): ${lastMessage}`,
    );
    this.name = 'OverloadExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/** Thrown when an in-progress backoff is interrupted by AbortSignal. */
export class OverloadAbortedError extends Error {
  constructor() {
    super('Overload retry backoff aborted');
    this.name = 'OverloadAbortedError';
  }
}

/** Heuristic for "is this error a 529/overloaded condition?". */
export function isOverloadedError(err: unknown): boolean {
  if (!err) return false;

  // SDK / fetch-style: { status: 529 }
  const candidate = err as {
    status?: number;
    statusCode?: number;
    type?: string;
    message?: string;
    error?: { type?: string; message?: string };
  };

  if (candidate.status === 529 || candidate.statusCode === 529) {
    return true;
  }
  if (candidate.type === 'overloaded_error') {
    return true;
  }
  if (candidate.error?.type === 'overloaded_error') {
    return true;
  }
  const message =
    typeof candidate.message === 'string'
      ? candidate.message
      : err instanceof Error
        ? err.message
        : String(err);
  if (message && /overloaded/i.test(message)) {
    return true;
  }
  return false;
}

/**
 * Sleep that resolves after `ms` or rejects with OverloadAbortedError
 * when signal fires. Uses unref'd timers so the loop never blocks
 * process exit.
 */
export async function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new OverloadAbortedError();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new OverloadAbortedError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn` and retry on overloaded errors. Non-overload errors propagate
 * immediately on the first failure. Aborts during backoff throw
 * `OverloadAbortedError`. Exhaustion throws `OverloadExhaustedError`.
 */
export async function callWithOverloadRetry<T>(
  fn: () => Promise<T>,
  options: OverloadRetryOptions = {},
): Promise<T> {
  const {
    maxRetries = DEFAULT_OVERLOAD_MAX_RETRIES,
    baseDelayMs = DEFAULT_OVERLOAD_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_OVERLOAD_MAX_DELAY_MS,
    jitterRatio = DEFAULT_OVERLOAD_JITTER_RATIO,
    signal,
    emit,
    taskId,
    random = Math.random,
    sleep = abortableSleep,
  } = options;

  let lastError: unknown;
  // attempt 0 = initial call; attempts 1..maxRetries = retries
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new OverloadAbortedError();
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isOverloadedError(err)) {
        throw err;
      }
      if (attempt === maxRetries) {
        break;
      }
      const baseDelay = Math.min(
        baseDelayMs * Math.pow(2, attempt),
        maxDelayMs,
      );
      // Centered jitter in [-jitterRatio, +jitterRatio]
      const jitter = baseDelay * jitterRatio * (random() * 2 - 1);
      const delayMs = Math.max(0, Math.round(baseDelay + jitter));
      emit?.({
        type: 'OverloadRetry',
        attempt: attempt + 1,
        maxAttempts: maxRetries,
        delayMs,
        errorMessage: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
        taskId,
      });
      await sleep(delayMs, signal);
    }
  }
  throw new OverloadExhaustedError(maxRetries + 1, lastError);
}
