/**
 * Serial Batch Uploader — Phase 9C
 *
 * Batches items and uploads them serially (at most 1 in-flight at a time).
 * Provides backpressure, exponential backoff with jitter, server-supplied
 * retry-after, drop-after-N-failures, and poison resistance.
 */

import { RetryableError } from './retryable-error';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SerialBatchUploaderConfig<T> {
  /** Upload function called with each batch. */
  upload: (batch: T[]) => Promise<void>;
  /** Maximum number of items per batch. */
  maxBatchSize: number;
  /** Maximum cumulative JSON byte length per batch. */
  maxBatchBytes: number;
  /** Maximum items allowed in the pending queue before backpressure. */
  maxQueueSize: number;
  /** Drop the batch after this many consecutive upload failures. */
  maxConsecutiveFailures: number;
  /** Base delay for exponential backoff (ms). Default 100. */
  baseDelayMs?: number;
  /** Maximum delay cap for backoff (ms). Default 30_000. */
  maxDelayMs?: number;
  /** Called when a batch is dropped after maxConsecutiveFailures. */
  onBatchDropped?: (batch: T[], error: unknown) => void;
}

interface BackpressureWaiter {
  resolve: () => void;
}

interface FlushWaiter {
  resolve: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// SerialBatchUploader
// ---------------------------------------------------------------------------

export class SerialBatchUploader<T> {
  private pending: T[] = [];
  private draining = false;
  private closed = false;
  private consecutiveFailures = 0;
  private backpressureWaiters: BackpressureWaiter[] = [];
  private flushWaiters: FlushWaiter[] = [];

  private readonly uploadFn: (batch: T[]) => Promise<void>;
  private readonly maxBatchSize: number;
  private readonly maxBatchBytes: number;
  private readonly maxQueueSize: number;
  private readonly maxConsecutiveFailures: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly onBatchDropped?: (batch: T[], error: unknown) => void;

  constructor(config: SerialBatchUploaderConfig<T>) {
    this.uploadFn = config.upload;
    this.maxBatchSize = config.maxBatchSize;
    this.maxBatchBytes = config.maxBatchBytes;
    this.maxQueueSize = config.maxQueueSize;
    this.maxConsecutiveFailures = config.maxConsecutiveFailures;
    this.baseDelayMs = config.baseDelayMs ?? 100;
    this.maxDelayMs = config.maxDelayMs ?? 30_000;
    this.onBatchDropped = config.onBatchDropped;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Enqueue a single item for batched upload.
   * Blocks (via Promise) when the queue is at capacity (backpressure).
   * Resolves immediately after the item is accepted into the queue.
   */
  async enqueue(item: T): Promise<void> {
    if (this.closed) return;

    // Backpressure: block while queue is at capacity
    while (this.pending.length >= this.maxQueueSize) {
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.backpressureWaiters.push({ resolve });
      });
      if (this.closed) return;
    }

    this.pending.push(item);
    this.scheduleDrain();
  }

  /**
   * Enqueue multiple items at once.
   * Each item individually respects backpressure.
   */
  async enqueueBatch(items: T[]): Promise<void> {
    for (const item of items) {
      await this.enqueue(item);
    }
  }

  /**
   * Returns a Promise that resolves when the pending queue is fully drained.
   */
  async flush(): Promise<void> {
    if (this.pending.length === 0 && !this.draining) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.flushWaiters.push({ resolve });
    });
  }

  /**
   * Drop all pending items, resolve all blocked callers, prevent future
   * enqueues. Does NOT perform a final upload.
   */
  close(): void {
    this.closed = true;
    this.pending = [];

    for (const waiter of this.backpressureWaiters.splice(0)) {
      waiter.resolve();
    }
    for (const waiter of this.flushWaiters.splice(0)) {
      waiter.resolve();
    }
  }

  /** Number of items currently in the pending queue. */
  get queueSize(): number {
    return this.pending.length;
  }

  // -------------------------------------------------------------------------
  // Drain loop
  // -------------------------------------------------------------------------

  private scheduleDrain(): void {
    if (this.draining || this.closed) return;
    this.draining = true;
    queueMicrotask(() => this.drain());
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0 && !this.closed) {
      const batch = this.takeBatch();
      if (batch.length === 0) break;

      try {
        await this.uploadFn(batch);
        this.consecutiveFailures = 0;
        this.releaseBackpressure();
      } catch (error: unknown) {
        this.consecutiveFailures++;

        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          this.onBatchDropped?.(batch, error);
          this.consecutiveFailures = 0;
          this.releaseBackpressure();
          continue;
        }

        // Re-prepend batch items for retry
        this.pending.unshift(...batch);
        const delay = this.calculateDelay(error);
        await sleep(delay);
      }
    }

    this.draining = false;

    if (this.pending.length === 0) {
      for (const waiter of this.flushWaiters.splice(0)) {
        waiter.resolve();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Batch formation
  // -------------------------------------------------------------------------

  private takeBatch(): T[] {
    const batch: T[] = [];
    let batchBytes = 0;
    const remaining: T[] = [];

    for (const item of this.pending) {
      let serialized: string;
      try {
        serialized = JSON.stringify(item);
      } catch {
        // Poison resistance: silently exclude items that can't serialize
        continue;
      }

      const itemBytes = byteLength(serialized);

      if (batch.length === 0) {
        // First item always goes in regardless of byte size
        batch.push(item);
        batchBytes = itemBytes;
      } else if (
        batch.length < this.maxBatchSize &&
        batchBytes + itemBytes <= this.maxBatchBytes
      ) {
        batch.push(item);
        batchBytes += itemBytes;
      } else {
        remaining.push(item);
      }
    }

    this.pending = remaining;
    return batch;
  }

  // -------------------------------------------------------------------------
  // Backoff & backpressure
  // -------------------------------------------------------------------------

  private calculateDelay(error: unknown): number {
    if (
      error instanceof RetryableError &&
      error.retryAfterMs !== undefined
    ) {
      return clamp(error.retryAfterMs, this.baseDelayMs, this.maxDelayMs);
    }

    const base =
      this.baseDelayMs * Math.pow(2, this.consecutiveFailures - 1);
    const jitter = Math.random() * base * 0.1;
    return Math.min(base + jitter, this.maxDelayMs);
  }

  private releaseBackpressure(): void {
    while (
      this.backpressureWaiters.length > 0 &&
      this.pending.length < this.maxQueueSize
    ) {
      const waiter = this.backpressureWaiters.shift()!;
      waiter.resolve();
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
