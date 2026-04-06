/**
 * Session State Machine -- pure function for validating session state transitions.
 *
 * Phase 9B: Bridge-Harness Separation (FR-9B.04)
 *
 * States: idle | working | requires_action | draining | failed
 * Transitions are validated; invalid transitions throw.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionState = 'idle' | 'working' | 'requires_action' | 'draining' | 'failed';

export interface SessionTransitionResult {
  readonly from: SessionState;
  readonly to: SessionState;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Transition table — defines which transitions are allowed
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: ReadonlyMap<SessionState, ReadonlySet<SessionState>> = new Map([
  ['idle', new Set<SessionState>(['working', 'draining', 'failed'])],
  ['working', new Set<SessionState>(['idle', 'requires_action', 'draining', 'failed'])],
  ['requires_action', new Set<SessionState>(['working', 'draining', 'failed'])],
  ['draining', new Set<SessionState>(['idle', 'failed'])],
  // 'failed' is terminal — no valid transitions out
  ['failed', new Set<SessionState>()],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate and execute a session state transition.
 *
 * Pure function — returns a result describing the transition.
 * Throws if the transition is not allowed.
 */
export function sessionTransition(
  current: SessionState,
  target: SessionState,
): SessionTransitionResult {
  if (current === target) {
    return { from: current, to: target, timestamp: Date.now() };
  }

  const allowed = VALID_TRANSITIONS.get(current);
  if (!allowed || !allowed.has(target)) {
    throw new Error(
      `Invalid session state transition: ${current} -> ${target}`,
    );
  }

  return {
    from: current,
    to: target,
    timestamp: Date.now(),
  };
}

/**
 * Check whether a transition from `current` to `target` is valid.
 */
export function isValidTransition(current: SessionState, target: SessionState): boolean {
  if (current === target) return true;
  const allowed = VALID_TRANSITIONS.get(current);
  return allowed !== undefined && allowed.has(target);
}

/**
 * Returns all states reachable from the given state.
 */
export function reachableStates(current: SessionState): readonly SessionState[] {
  const allowed = VALID_TRANSITIONS.get(current);
  return allowed ? [...allowed] : [];
}
