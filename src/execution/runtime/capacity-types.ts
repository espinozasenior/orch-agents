/**
 * Type definitions for the Capacity-Aware Wake system (Phase 9D).
 *
 * Defines the CapacityProvider interface (contract for Phase 9B SwarmDaemon),
 * PollConfig with validation, and CapacityMetrics for health reporting.
 */

// ---------------------------------------------------------------------------
// CapacityProvider — interface we need from Phase 9B SwarmDaemon
// ---------------------------------------------------------------------------

export interface CapacityProvider {
  /** Number of slots currently available for new work. */
  getAvailableSlots(): number;
  /** Signal that fires (aborts) when any slot is freed. */
  onSlotFreed: AbortSignal;
}

// ---------------------------------------------------------------------------
// PollConfig
// ---------------------------------------------------------------------------

export interface PollConfig {
  /** Interval between polls when slots are available (default 2000ms, min 100ms). */
  seekingIntervalMs: number;
  /** Interval between polls when at capacity (default 600_000ms, min 100ms). */
  atCapacityIntervalMs: number;
  /** Heartbeat interval — at least one of heartbeat/keepalive is required. */
  heartbeatIntervalMs?: number;
  /** Keepalive interval — at least one of heartbeat/keepalive is required. */
  keepaliveIntervalMs?: number;
  /** Maximum concurrent agent slots (min 1, default 3). */
  maxSlotsTotal: number;
}

const POLL_DEFAULTS: PollConfig = {
  seekingIntervalMs: 2000,
  atCapacityIntervalMs: 600_000,
  maxSlotsTotal: 3,
};

// ---------------------------------------------------------------------------
// PollConfig validation (replaces Zod — no runtime dependency needed)
// ---------------------------------------------------------------------------

export class PollConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`PollConfig validation failed: ${issues.join('; ')}`);
    this.name = 'PollConfigValidationError';
  }
}

/** Merge partial input with defaults and validate. Throws on invalid config. */
export function parsePollConfig(input: Partial<PollConfig> = {}): PollConfig {
  const config: PollConfig = { ...POLL_DEFAULTS, ...input };
  const issues: string[] = [];

  if (config.seekingIntervalMs < 100) {
    issues.push(`seekingIntervalMs must be >= 100ms, got ${config.seekingIntervalMs}`);
  }
  if (config.atCapacityIntervalMs < 100) {
    issues.push(`atCapacityIntervalMs must be >= 100ms, got ${config.atCapacityIntervalMs}`);
  }
  if (config.heartbeatIntervalMs != null && config.heartbeatIntervalMs < 100) {
    issues.push(`heartbeatIntervalMs must be >= 100ms, got ${config.heartbeatIntervalMs}`);
  }
  if (config.keepaliveIntervalMs != null && config.keepaliveIntervalMs < 100) {
    issues.push(`keepaliveIntervalMs must be >= 100ms, got ${config.keepaliveIntervalMs}`);
  }
  if (config.maxSlotsTotal < 1) {
    issues.push(`maxSlotsTotal must be >= 1, got ${config.maxSlotsTotal}`);
  }
  if (config.heartbeatIntervalMs == null && config.keepaliveIntervalMs == null) {
    issues.push('At least one liveness mechanism (heartbeatIntervalMs or keepaliveIntervalMs) is required');
  }

  if (issues.length > 0) {
    throw new PollConfigValidationError(issues);
  }

  return config;
}

// ---------------------------------------------------------------------------
// CapacityMetrics
// ---------------------------------------------------------------------------

export interface CapacityMetrics {
  slots_total: number;
  slots_used: number;
  slots_available: number;
  wake_count: number;
  polls_skipped: number;
}
