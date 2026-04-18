/**
 * Event deduplication buffer and rate limiter for GitHub webhooks.
 *
 * Tracks delivery IDs in a Map with TTL to detect duplicate deliveries.
 * Also enforces per-repository rate limits.
 */

import { ConflictError, RateLimitError } from '../kernel/errors';

interface DeliveryRecord {
  timestamp: number;
}

interface RateWindow {
  count: number;
  windowStart: number;
}

export interface EventBufferOptions {
  /** TTL in milliseconds for deduplication (default: 30000) */
  deduplicationTtlMs?: number;
  /** Maximum events per minute per repository (default: 100) */
  maxEventsPerMinute?: number;
  /** Cleanup interval in milliseconds (default: 10000) */
  cleanupIntervalMs?: number;
}

export interface EventBuffer {
  /**
   * Check if a delivery ID is a duplicate and record it.
   * Also enforces rate limiting per repository.
   *
   * @param deliveryId - The X-GitHub-Delivery header value
   * @param repoFullName - The repository full name (owner/repo)
   * @throws {ConflictError} If the delivery ID is a duplicate
   * @throws {RateLimitError} If the repository exceeds the rate limit
   */
  check(deliveryId: string, repoFullName: string): void;

  /**
   * Stop the periodic cleanup timer. Call on shutdown.
   */
  dispose(): void;
}

export function createEventBuffer(options: EventBufferOptions = {}): EventBuffer {
  const deduplicationTtlMs = options.deduplicationTtlMs ?? 30_000;
  const maxEventsPerMinute = options.maxEventsPerMinute ?? 100;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 10_000;
  const windowMs = 60_000; // 1 minute window for rate limiting

  const deliveries = new Map<string, DeliveryRecord>();
  const rateLimits = new Map<string, RateWindow>();

  function cleanup(): void {
    const now = Date.now();

    // Clean expired delivery records
    for (const [id, record] of deliveries) {
      if (now - record.timestamp > deduplicationTtlMs) {
        deliveries.delete(id);
      }
    }

    // Clean expired rate limit windows
    for (const [repo, window] of rateLimits) {
      if (now - window.windowStart > windowMs) {
        rateLimits.delete(repo);
      }
    }
  }

  const cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
  // Allow the process to exit even if the timer is still running
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  return {
    check(deliveryId: string, repoFullName: string): void {
      const now = Date.now();

      // Check deduplication
      const existing = deliveries.get(deliveryId);
      if (existing && now - existing.timestamp <= deduplicationTtlMs) {
        throw new ConflictError(`Duplicate delivery: ${deliveryId}`);
      }

      // Check rate limit
      const window = rateLimits.get(repoFullName);
      if (window) {
        if (now - window.windowStart > windowMs) {
          // Window expired, start new window
          rateLimits.set(repoFullName, { count: 1, windowStart: now });
        } else if (window.count >= maxEventsPerMinute) {
          const retryAfter = Math.ceil(
            (windowMs - (now - window.windowStart)) / 1000,
          );
          throw new RateLimitError(retryAfter);
        } else {
          window.count += 1;
        }
      } else {
        rateLimits.set(repoFullName, { count: 1, windowStart: now });
      }

      // Record delivery
      deliveries.set(deliveryId, { timestamp: now });
    },

    dispose(): void {
      clearInterval(cleanupTimer);
      deliveries.clear();
      rateLimits.clear();
    },
  };
}
