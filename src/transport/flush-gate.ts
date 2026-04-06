/**
 * FlushGate<T> — queues live messages during historical flush, drains after flush completes.
 * FR-9E.01: Generic class that queues live messages while historical flush completes.
 * FR-9E.02: Gate opens after historical message POST completes; queued live messages drain FIFO.
 *
 * NFR: Zero overhead in passthrough state (gate already open).
 * NFR: Queue caps at 10,000 messages to prevent unbounded growth.
 */

export type FlushGateState = 'queuing' | 'flushing' | 'open';

export class FlushGateOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlushGateOverflowError';
  }
}

export type MessageHandler<T> = (msg: T) => Promise<void>;

const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const QUEUE_WARNING_THRESHOLD = 5_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 30_000;

export class FlushGate<T> {
  private _state: FlushGateState = 'queuing';
  private _queue: T[] = [];
  private _handler: MessageHandler<T> | null = null;
  private readonly _maxQueueSize: number;
  private readonly _flushTimeoutMs: number;
  private _onWarning: ((msg: string) => void) | null = null;

  constructor(options?: {
    maxQueueSize?: number;
    flushTimeoutMs?: number;
    onWarning?: (msg: string) => void;
  }) {
    this._maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this._flushTimeoutMs = options?.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this._onWarning = options?.onWarning ?? null;
  }

  get state(): FlushGateState {
    return this._state;
  }

  get queueLength(): number {
    return this._queue.length;
  }

  /**
   * Register the downstream message handler.
   */
  onMessage(handler: MessageHandler<T>): void {
    this._handler = handler;
  }

  /**
   * Receive a live message.
   * - In 'open' state: passes through immediately (zero overhead path).
   * - In 'queuing' or 'flushing' state: buffers the message.
   */
  async receive(msg: T): Promise<void> {
    if (this._state === 'open') {
      // Passthrough — zero overhead path
      if (this._handler) {
        await this._handler(msg);
      }
      return;
    }

    // Buffer while queuing or flushing
    if (this._queue.length >= this._maxQueueSize) {
      throw new FlushGateOverflowError(
        `Queue exceeded ${this._maxQueueSize} messages`
      );
    }

    if (this._queue.length === QUEUE_WARNING_THRESHOLD && this._onWarning) {
      this._onWarning(
        `FlushGate queue reached ${QUEUE_WARNING_THRESHOLD} messages`
      );
    }

    this._queue.push(msg);
  }

  /**
   * Deliver historical messages in order, then drain queued live messages.
   * FR-9E.02: Gate opens after historical delivery; queued messages drain FIFO.
   *
   * Edge case: 30-second flush timeout opens gate with a warning if flush
   * never completes (server sends incomplete history).
   */
  async flush(historicalMessages: T[]): Promise<void> {
    this._state = 'flushing';

    const flushPromise = this._deliverFlush(historicalMessages);

    // Flush timeout — opens gate with warning if flush hangs
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), this._flushTimeoutMs);
      // Don't prevent process exit
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }
    });

    const result = await Promise.race([
      flushPromise.then(() => 'done' as const),
      timeoutPromise,
    ]);

    if (result === 'timeout') {
      this._onWarning?.(
        `FlushGate flush timed out after ${this._flushTimeoutMs}ms — opening gate with potential data gap`
      );
      this._state = 'open';
      await this._drainQueue();
    }
  }

  private async _deliverFlush(historicalMessages: T[]): Promise<void> {
    // Deliver historical messages in order
    for (const msg of historicalMessages) {
      if (this._handler) {
        await this._handler(msg);
      }
    }

    // Open gate and drain queued live messages
    this._state = 'open';
    await this._drainQueue();
  }

  private async _drainQueue(): Promise<void> {
    while (this._queue.length > 0) {
      const msg = this._queue.shift()!;
      if (this._handler) {
        await this._handler(msg);
      }
    }
  }

  /**
   * Reset gate to queuing state. Used on reconnect.
   */
  reset(): void {
    this._state = 'queuing';
    this._queue = [];
  }
}
