/**
 * Reconnection budget, exponential backoff, and sleep/wake detection.
 * FR-9E.06: Reconnection budget — 10-minute window with exponential backoff (1s-30s, jitter +/-20%).
 * FR-9E.07: Sleep/wake detection — gap > 2x backoff cap (60s) resets budget.
 * FR-9E.08: Permanent close codes abort reconnection immediately.
 */

import { isPermanentCloseCode } from './transport.js';

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
export const BUDGET_MS = 600_000; // 10 minutes
export const SLEEP_WAKE_THRESHOLD_MS = 2 * BACKOFF_CAP_MS; // 60s

export interface ReconnectionState {
  budgetMs: number;
  budgetStartTime: number;
  currentBackoffMs: number;
  lastAttemptTime: number;
}

/**
 * Create a fresh reconnection state.
 */
export function createReconnectionState(now: number = Date.now()): ReconnectionState {
  return {
    budgetMs: BUDGET_MS,
    budgetStartTime: now,
    currentBackoffMs: BACKOFF_BASE_MS,
    lastAttemptTime: now,
  };
}

/**
 * Determine whether to attempt reconnection.
 * Returns false for permanent close codes or exhausted budget.
 * Detects sleep/wake and resets budget when gap >= 60s.
 */
export function shouldReconnect(
  state: ReconnectionState,
  closeCode: number,
  now: number = Date.now()
): boolean {
  // FR-9E.08: permanent close codes abort immediately
  if (isPermanentCloseCode(closeCode)) {
    return false;
  }

  // FR-9E.07: Sleep/wake detection — gap >= 2x backoff cap resets budget
  const gap = now - state.lastAttemptTime;
  if (gap >= SLEEP_WAKE_THRESHOLD_MS) {
    state.budgetStartTime = now;
    state.currentBackoffMs = BACKOFF_BASE_MS;
  }

  // Check budget exhaustion
  const elapsed = now - state.budgetStartTime;
  if (elapsed >= state.budgetMs) {
    return false;
  }

  return true;
}

/**
 * Calculate the next backoff delay with +/-20% jitter.
 * Advances the backoff state (doubles currentBackoffMs up to cap).
 */
export function nextBackoff(
  state: ReconnectionState,
  now: number = Date.now(),
  random: () => number = Math.random
): number {
  const jitter = state.currentBackoffMs * 0.2 * (random() * 2 - 1);
  const delay = state.currentBackoffMs + jitter;
  state.currentBackoffMs = Math.min(state.currentBackoffMs * 2, BACKOFF_CAP_MS);
  state.lastAttemptTime = now;
  return delay;
}
