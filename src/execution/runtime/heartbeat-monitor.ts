/**
 * Heartbeat monitor for child sessions.
 *
 * Phase P7: NDJSON Permission Negotiation (FR-P7-008)
 *
 * Detects hung child sessions by tracking missed heartbeats.
 * After `maxMissed` consecutive misses, calls the `onKill` callback.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatMonitorConfig {
  readonly intervalMs?: number;   // default 60_000
  readonly maxMissed?: number;    // default 3
  readonly onKill: () => void;
}

export interface HeartbeatMonitor {
  start(): void;
  stop(): void;
  recordActivity(): void;
  recordMiss(): void;
  shouldPing(sessionState: string): boolean;
  readonly missedCount: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const SKIP_STATES = new Set(['idle', 'stopped', 'crashed', 'failed']);

export function createHeartbeatMonitor(config: HeartbeatMonitorConfig): HeartbeatMonitor {
  const intervalMs = config.intervalMs ?? 60_000;
  const maxMissed = config.maxMissed ?? 3;
  let missed = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    missed += 1;
    if (missed >= maxMissed) {
      stop();
      config.onKill();
    }
  }

  function start(): void {
    if (timer !== null) return;
    missed = 0;
    timer = setInterval(tick, intervalMs);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function recordActivity(): void {
    missed = 0;
  }

  function recordMiss(): void {
    missed += 1;
    if (missed >= maxMissed) {
      stop();
      config.onKill();
    }
  }

  function shouldPing(sessionState: string): boolean {
    return !SKIP_STATES.has(sessionState);
  }

  return {
    start,
    stop,
    recordActivity,
    recordMiss,
    shouldPing,
    get missedCount() {
      return missed;
    },
  };
}
