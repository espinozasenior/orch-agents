/**
 * Pure-function state machine for automation pause/resume lifecycle.
 *
 * Auto-pauses after 3 consecutive failures. Success resets the counter.
 * No side effects -- callers are responsible for persisting state changes.
 */

// ---------------------------------------------------------------------------
// State type
// ---------------------------------------------------------------------------

export interface AutomationState {
  automationId: string;
  consecutiveFailures: number;
  paused: boolean;
  pausedAt?: string;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'failed';
}

/** Number of consecutive failures that triggers auto-pause. */
const AUTO_PAUSE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export function createInitialState(automationId: string): AutomationState {
  return {
    automationId,
    consecutiveFailures: 0,
    paused: false,
  };
}

/**
 * Record a successful run. Resets the failure counter.
 */
export function recordSuccess(state: AutomationState): AutomationState {
  return {
    ...state,
    consecutiveFailures: 0,
    lastRunAt: new Date().toISOString(),
    lastRunStatus: 'success',
    // If it was paused somehow and succeeded (e.g. manual trigger), keep paused
    // -- operator must explicitly resume.
  };
}

/**
 * Record a failed run. Increments the failure counter.
 * Returns the new state and whether it just became paused.
 */
export function recordFailure(
  state: AutomationState,
): { state: AutomationState; paused: boolean } {
  const consecutiveFailures = state.consecutiveFailures + 1;
  const shouldPause = !state.paused && consecutiveFailures >= AUTO_PAUSE_THRESHOLD;

  const newState: AutomationState = {
    ...state,
    consecutiveFailures,
    lastRunAt: new Date().toISOString(),
    lastRunStatus: 'failed',
    ...(shouldPause ? { paused: true, pausedAt: new Date().toISOString() } : {}),
  };

  return { state: newState, paused: shouldPause };
}

/**
 * Resume a paused automation. Resets the failure counter so it gets
 * a fresh chance before being paused again.
 */
export function resume(state: AutomationState): AutomationState {
  return {
    ...state,
    paused: false,
    pausedAt: undefined,
    consecutiveFailures: 0,
  };
}
