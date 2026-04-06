/**
 * Capacity Metrics Collector (Phase 9D).
 *
 * Lock-free counter tracker for wake events, poll counts, and slot utilisation.
 * Safe for concurrent reads from health endpoints (all fields are plain numbers —
 * single-threaded JS guarantees atomic reads of numeric primitives).
 */

import type { CapacityMetrics } from './capacity-types';

// ---------------------------------------------------------------------------
// Wake event record
// ---------------------------------------------------------------------------

export interface WakeEvent {
  readonly timestamp: number;
  readonly trigger: 'signal' | 'timer' | 'config-reload' | 'close';
}

// ---------------------------------------------------------------------------
// CapacityMetricsCollector
// ---------------------------------------------------------------------------

export class CapacityMetricsCollector {
  private _slotsTotal: number;
  private _slotsUsed = 0;
  private _wakeCount = 0;
  private _pollsSkipped = 0;
  private readonly _recentWakes: WakeEvent[] = [];
  private readonly _maxRecentWakes: number;

  constructor(slotsTotal: number, maxRecentWakes = 50) {
    this._slotsTotal = slotsTotal;
    this._maxRecentWakes = maxRecentWakes;
  }

  // -----------------------------------------------------------------------
  // Mutations
  // -----------------------------------------------------------------------

  updateSlots(used: number, total?: number): void {
    this._slotsUsed = used;
    if (total != null) {
      this._slotsTotal = total;
    }
  }

  recordWake(trigger: WakeEvent['trigger']): void {
    this._wakeCount++;
    const event: WakeEvent = { timestamp: Date.now(), trigger };
    this._recentWakes.push(event);
    if (this._recentWakes.length > this._maxRecentWakes) {
      this._recentWakes.shift();
    }
  }

  recordPollSkipped(): void {
    this._pollsSkipped++;
  }

  // -----------------------------------------------------------------------
  // Queries (lock-free, safe for concurrent health reads)
  // -----------------------------------------------------------------------

  snapshot(): CapacityMetrics {
    return {
      slots_total: this._slotsTotal,
      slots_used: this._slotsUsed,
      slots_available: this._slotsTotal - this._slotsUsed,
      wake_count: this._wakeCount,
      polls_skipped: this._pollsSkipped,
    };
  }

  get wakeCount(): number {
    return this._wakeCount;
  }

  get pollsSkipped(): number {
    return this._pollsSkipped;
  }

  recentWakes(): readonly WakeEvent[] {
    return this._recentWakes;
  }
}
