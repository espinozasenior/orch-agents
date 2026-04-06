/**
 * Text Delta Accumulator — Phase 9C
 *
 * Accumulates streaming text deltas into a full-so-far buffer and
 * flushes a complete snapshot on a configurable interval (default 100ms).
 * Consumers listen via the `onSnapshot` callback.
 */

export interface TextDeltaAccumulatorConfig {
  /** Interval between automatic snapshot flushes (ms). Default 100. */
  flushIntervalMs?: number;
  /** Called with the full accumulated text on each flush. */
  onSnapshot: (snapshot: string) => void;
}

export class TextDeltaAccumulator {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs: number;
  private readonly onSnapshot: (snapshot: string) => void;

  constructor(config: TextDeltaAccumulatorConfig) {
    this.flushIntervalMs = config.flushIntervalMs ?? 100;
    this.onSnapshot = config.onSnapshot;
  }

  /**
   * Append a text delta to the accumulation buffer.
   * Starts the flush timer if not already running.
   */
  append(delta: string): void {
    this.buffer += delta;
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  /**
   * Flush the current buffer as a snapshot immediately.
   * Returns the accumulated text. Clears the timer.
   */
  flush(): string {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const snapshot = this.buffer;
    if (snapshot.length > 0) {
      this.onSnapshot(snapshot);
    }
    return snapshot;
  }

  /**
   * Close the accumulator, clearing timers. Does NOT flush.
   */
  close(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = '';
  }
}
