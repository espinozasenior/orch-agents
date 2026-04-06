/**
 * Error subclass indicating that the failed operation may be retried.
 *
 * When `retryAfterMs` is set (e.g., from an HTTP 429 Retry-After header),
 * the uploader uses that value (clamped to configured bounds) instead of
 * its own exponential backoff.
 */
export class RetryableError extends Error {
  public readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableError';
    this.retryAfterMs = retryAfterMs;
  }
}
