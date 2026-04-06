/**
 * Coalescing Uploader — Phase 9C
 *
 * Holds at most 1 pending state object. Rapid updates are merged via
 * RFC 7396 JSON Merge Patch semantics before being handed to an
 * underlying SerialBatchUploader for upload.
 */

import {
  SerialBatchUploader,
  type SerialBatchUploaderConfig,
} from './serial-batch-uploader';

// ---------------------------------------------------------------------------
// JSON Merge Patch (RFC 7396)
// ---------------------------------------------------------------------------

/**
 * Apply a JSON Merge Patch to a target value.
 *
 * - If `patch` is not a plain object, return `patch` (replacement).
 * - If `patch` has a key with value `null`, delete that key from target.
 * - Otherwise recursively merge.
 */
export function jsonMergePatch<T>(target: T, patch: Partial<T>): T {
  if (!isPlainObject(patch)) {
    return patch as T;
  }

  const result: Record<string, unknown> = isPlainObject(target)
    ? { ...(target as Record<string, unknown>) }
    : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = jsonMergePatch(result[key], value as Partial<unknown>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

// ---------------------------------------------------------------------------
// CoalescingUploader
// ---------------------------------------------------------------------------

export interface CoalescingUploaderConfig<T> {
  upload: (batch: T[]) => Promise<void>;
  maxConsecutiveFailures: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onBatchDropped?: (batch: T[], error: unknown) => void;
}

export class CoalescingUploader<T extends Record<string, unknown>> {
  private pending: T | null = null;
  private readonly uploader: SerialBatchUploader<T>;

  constructor(config: CoalescingUploaderConfig<T>) {
    this.uploader = new SerialBatchUploader<T>({
      upload: config.upload,
      maxBatchSize: 1,
      maxBatchBytes: Infinity,
      maxQueueSize: 1,
      maxConsecutiveFailures: config.maxConsecutiveFailures,
      baseDelayMs: config.baseDelayMs,
      maxDelayMs: config.maxDelayMs,
      onBatchDropped: config.onBatchDropped,
    } satisfies SerialBatchUploaderConfig<T>);
  }

  /**
   * Merge `partial` into the pending state using JSON Merge Patch (RFC 7396),
   * then enqueue the merged result for upload.
   */
  async update(partial: Partial<T>): Promise<void> {
    if (this.pending === null) {
      this.pending = partial as T;
    } else {
      this.pending = jsonMergePatch(this.pending, partial);
    }

    const snapshot = this.pending;
    this.pending = null;
    await this.uploader.enqueue(snapshot);
  }

  async flush(): Promise<void> {
    return this.uploader.flush();
  }

  close(): void {
    this.pending = null;
    this.uploader.close();
  }
}
