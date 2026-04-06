/**
 * Capacity-Aware Wake with AbortSignal Merging (Phase 9D).
 *
 * Two-tier polling: fast cadence (2s) when slots exist, long sleep (10min)
 * when at capacity. The at-capacity sleep wakes instantly via merged
 * AbortSignal the moment any session completes.
 *
 * See docs/sparc/phase-9d-capacity-wake.md for full specification.
 */

import type { CapacityMetrics, PollConfig } from './capacity-types';
import { parsePollConfig } from './capacity-types';
import { CapacityMetricsCollector } from './capacity-metrics';
import type { ConcurrencyClass } from '../../execution/task/types';

// ---------------------------------------------------------------------------
// Slot-changed event payload (for external listeners)
// ---------------------------------------------------------------------------

export interface SlotChangedEvent {
  slotsUsed: number;
  slotsTotal: number;
  action: 'acquired' | 'released';
  timestamp: number;
  /** P6: ConcurrencyClass that triggered the slot change, if applicable. */
  concurrencyClass?: ConcurrencyClass;
}

export type SlotChangedListener = (event: SlotChangedEvent) => void;

// ---------------------------------------------------------------------------
// Helper: wait for an AbortSignal to fire
// ---------------------------------------------------------------------------

function abortableWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

// ---------------------------------------------------------------------------
// Helper: cancellable sleep (rejects on abort, resolves on timeout)
// ---------------------------------------------------------------------------

function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// CapacityWake
// ---------------------------------------------------------------------------

/** P6: Per-class slot pool configuration. */
export interface ClassSlotConfig {
  max: number;
}

export class CapacityWake {
  private _config: PollConfig;
  private _slotsUsed = 0;
  private _wakeController: AbortController | null = null;
  private _closed = false;
  private _lastTickTime: number = Date.now();
  private readonly _metrics: CapacityMetricsCollector;
  private readonly _listeners: SlotChangedListener[] = [];
  /** P6: Per-ConcurrencyClass slot pools. */
  private readonly _classPools = new Map<string, { used: number; max: number }>();

  constructor(config: Partial<PollConfig> & { maxSlotsTotal?: number; heartbeatIntervalMs?: number; keepaliveIntervalMs?: number }) {
    this._config = parsePollConfig(config);
    this._metrics = new CapacityMetricsCollector(this._config.maxSlotsTotal);
  }

  // -----------------------------------------------------------------------
  // Capacity queries
  // -----------------------------------------------------------------------

  isAtCapacity(): boolean {
    return this._slotsUsed >= this._config.maxSlotsTotal;
  }

  get slotsUsed(): number {
    return this._slotsUsed;
  }

  get config(): Readonly<PollConfig> {
    return this._config;
  }

  get closed(): boolean {
    return this._closed;
  }

  // -----------------------------------------------------------------------
  // Slot management
  // -----------------------------------------------------------------------

  acquireSlot(): boolean {
    if (this.isAtCapacity()) return false;
    this._slotsUsed++;
    this._updateMetrics();
    this._emit({ slotsUsed: this._slotsUsed, slotsTotal: this._config.maxSlotsTotal, action: 'acquired', timestamp: Date.now() });
    return true;
  }

  releaseSlot(): void {
    this._slotsUsed = Math.max(0, this._slotsUsed - 1);
    this._updateMetrics();
    this._emit({ slotsUsed: this._slotsUsed, slotsTotal: this._config.maxSlotsTotal, action: 'released', timestamp: Date.now() });

    // Wake the capacity waiter instantly
    if (this._wakeController) {
      this._wakeController.abort();
      this._wakeController = null;
      this._metrics.recordWake('signal');
    }
  }

  // -----------------------------------------------------------------------
  // P6: ConcurrencyClass-aware slot management
  // -----------------------------------------------------------------------

  /**
   * Configure the max slot count for a ConcurrencyClass.
   * Must be called before acquireForClass/releaseForClass.
   */
  configureClassPool(concurrencyClass: ConcurrencyClass, max: number): void {
    const existing = this._classPools.get(concurrencyClass);
    if (existing) {
      existing.max = max;
    } else {
      this._classPools.set(concurrencyClass, { used: 0, max });
    }
  }

  /**
   * Acquire a slot for a ConcurrencyClass.
   * Monitor class is always admitted (exempt from limits).
   * Returns true if the slot was acquired.
   */
  acquireForClass(concurrencyClass: ConcurrencyClass): boolean {
    // Monitors are always admitted
    if (concurrencyClass === 'monitor') {
      return this.acquireSlot();
    }

    // Check class-level pool
    const pool = this._classPools.get(concurrencyClass);
    if (pool && pool.used >= pool.max) {
      return false;
    }

    // Check global capacity
    if (!this.acquireSlot()) {
      return false;
    }

    // Increment class pool
    if (pool) {
      pool.used++;
    }
    return true;
  }

  /**
   * Release a slot for a ConcurrencyClass.
   * Monitor class release is a no-op for class tracking.
   */
  releaseForClass(concurrencyClass: ConcurrencyClass): void {
    this.releaseSlot();

    if (concurrencyClass === 'monitor') {
      return;
    }

    const pool = this._classPools.get(concurrencyClass);
    if (pool) {
      pool.used = Math.max(0, pool.used - 1);
    }
  }

  /** P6: Get the current usage for a ConcurrencyClass pool. */
  getClassPoolUsage(concurrencyClass: ConcurrencyClass): { used: number; max: number } | undefined {
    return this._classPools.get(concurrencyClass);
  }

  // -----------------------------------------------------------------------
  // Wait for capacity (core two-tier mechanism)
  // -----------------------------------------------------------------------

  async waitForCapacity(): Promise<void> {
    if (!this.isAtCapacity()) return;

    // Create abort controller for instant wake on slot release
    this._wakeController = new AbortController();

    // Create timer-based abort for the long at-capacity sleep
    const timerController = new AbortController();
    const timer = setTimeout(
      () => timerController.abort(),
      this._config.atCapacityIntervalMs,
    );

    // Merge signals: wake on EITHER slot freed OR timer expiry
    const mergedSignal = AbortSignal.any([
      this._wakeController.signal,
      timerController.signal,
    ]);

    try {
      await abortableWait(mergedSignal);
    } finally {
      clearTimeout(timer);
      this._metrics.recordPollSkipped();
    }
  }

  // -----------------------------------------------------------------------
  // Poll loop — drives the daemon
  // -----------------------------------------------------------------------

  async pollLoop(pollFn: () => Promise<void>): Promise<void> {
    while (!this._closed) {
      const now = Date.now();
      const elapsed = now - this._lastTickTime;

      // Sleep/wake detection (FR-9D.07)
      if (elapsed > 2 * this._config.atCapacityIntervalMs) {
        this._resetReconnectionBudget();
      }

      this._lastTickTime = now;

      if (this.isAtCapacity()) {
        await this.waitForCapacity();
        continue; // Re-check capacity after wake
      }

      try {
        await pollFn();
      } catch (_error) {
        // Poll failure logged by caller; we continue the loop
      }

      // Sleep for seeking interval (cancellable on close)
      if (!this._closed) {
        const closeController = new AbortController();
        const closeCb = (): void => closeController.abort();

        // Watch for close during sleep
        if (this._closed) break;
        this._onCloseCallbacks.push(closeCb);
        await cancellableSleep(this._config.seekingIntervalMs, closeController.signal);
        const idx = this._onCloseCallbacks.indexOf(closeCb);
        if (idx >= 0) this._onCloseCallbacks.splice(idx, 1);
      }
    }
  }

  private _onCloseCallbacks: Array<() => void> = [];

  // -----------------------------------------------------------------------
  // Sleep/wake detection (FR-9D.07)
  // -----------------------------------------------------------------------

  private _resetReconnectionBudget(): void {
    // Reset any exponential backoff state on upstream connections
    this._lastTickTime = Date.now();
  }

  /** Exposed for testing sleep/wake detection. */
  setLastTickTime(time: number): void {
    this._lastTickTime = time;
  }

  /** Check if a gap would trigger reconnection budget reset. */
  wouldResetBudget(elapsed: number): boolean {
    return elapsed > 2 * this._config.atCapacityIntervalMs;
  }

  // -----------------------------------------------------------------------
  // Hot-reload (FR-9D.09)
  // -----------------------------------------------------------------------

  updateConfig(newConfig: Partial<PollConfig>): void {
    const merged = { ...this._config, ...newConfig };
    this._config = parsePollConfig(merged);
    this._metrics.updateSlots(this._slotsUsed, this._config.maxSlotsTotal);

    // If at capacity and the at-capacity interval changed, wake immediately
    if (this._wakeController && newConfig.atCapacityIntervalMs != null) {
      this._wakeController.abort();
      this._wakeController = null;
      this._metrics.recordWake('config-reload');
    }
  }

  // -----------------------------------------------------------------------
  // Metrics
  // -----------------------------------------------------------------------

  getMetrics(): CapacityMetrics {
    return this._metrics.snapshot();
  }

  get metricsCollector(): CapacityMetricsCollector {
    return this._metrics;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  close(): void {
    this._closed = true;
    if (this._wakeController) {
      this._wakeController.abort();
      this._wakeController = null;
      this._metrics.recordWake('close');
    }
    // Wake any sleeping seeking intervals
    for (const cb of this._onCloseCallbacks) cb();
    this._onCloseCallbacks.length = 0;
  }

  // -----------------------------------------------------------------------
  // Event listeners
  // -----------------------------------------------------------------------

  onSlotChanged(listener: SlotChangedListener): void {
    this._listeners.push(listener);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private _updateMetrics(): void {
    this._metrics.updateSlots(this._slotsUsed, this._config.maxSlotsTotal);
  }

  private _emit(event: SlotChangedEvent): void {
    for (const listener of this._listeners) {
      listener(event);
    }
  }
}
