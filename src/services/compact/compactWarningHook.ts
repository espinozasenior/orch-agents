/**
 * Compact Warning Hook (FR-P10-006)
 *
 * Computes a per-turn warning state and returns the event the query
 * loop should emit. Mirrors CC's `compactWarningHook.ts` +
 * `compactWarningState.ts` pair: callers can suppress warnings
 * (per session) and the suppression is honoured until the threshold
 * delta crosses again.
 */

import type { CompactMessage } from './types';
import { tokenCountWithEstimation } from './tokenEstimator';
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_THRESHOLD_BUFFER_TOKENS,
} from './types';

// ---------------------------------------------------------------------------
// Warning state with thresholds
// ---------------------------------------------------------------------------

export interface ExtendedWarningState {
  readonly currentTokens: number;
  readonly contextWindowTokens: number;
  readonly warningThreshold: number;
  readonly errorThreshold: number;
  readonly autoCompactThreshold: number;
  readonly isAboveWarningThreshold: boolean;
  readonly isAboveErrorThreshold: boolean;
  readonly isAboveAutoCompactThreshold: boolean;
  readonly percentLeft: number;
  readonly recommended: 'snip' | 'compact' | 'block' | 'none';
}

export function computeWarningState(
  messages: readonly CompactMessage[],
  contextWindowTokens: number,
): ExtendedWarningState {
  const currentTokens = tokenCountWithEstimation(messages);

  // CC layout: warning < autoCompact < error.
  // warning fires ~10% before the autocompact threshold.
  const autoCompactThreshold = contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS;
  const warningThreshold = contextWindowTokens - WARNING_THRESHOLD_BUFFER_TOKENS;
  const errorThreshold = contextWindowTokens - 2_000;

  const isAboveAutoCompactThreshold = currentTokens >= autoCompactThreshold;
  const isAboveErrorThreshold = currentTokens >= errorThreshold;
  const isAboveWarningThreshold = currentTokens >= warningThreshold;

  const percentLeft = Math.max(
    0,
    1 - currentTokens / Math.max(1, contextWindowTokens),
  );

  let recommended: ExtendedWarningState['recommended'] = 'none';
  if (isAboveErrorThreshold) recommended = 'block';
  else if (isAboveAutoCompactThreshold) recommended = 'compact';
  else if (isAboveWarningThreshold) recommended = 'snip';

  return Object.freeze({
    currentTokens,
    contextWindowTokens,
    warningThreshold,
    errorThreshold,
    autoCompactThreshold,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    percentLeft,
    recommended,
  });
}

// ---------------------------------------------------------------------------
// Suppression state (per session)
// ---------------------------------------------------------------------------

interface SuppressionRecord {
  suppressed: boolean;
  /** Token count at which the user dismissed the warning. The next
   *  emission only fires after the count crosses this anchor + delta. */
  suppressedAtTokens: number;
}

const SUPPRESSION = new Map<string, SuppressionRecord>();
const SUPPRESSION_RESET_DELTA = 5_000;

export function suppressCompactWarning(
  sessionId: string,
  currentTokens: number,
): void {
  SUPPRESSION.set(sessionId, {
    suppressed: true,
    suppressedAtTokens: currentTokens,
  });
}

export function clearCompactWarningSuppression(sessionId: string): void {
  SUPPRESSION.delete(sessionId);
}

export function isCompactWarningSuppressed(
  sessionId: string,
  currentTokens: number,
): boolean {
  const rec = SUPPRESSION.get(sessionId);
  if (!rec) return false;
  if (!rec.suppressed) return false;
  // Auto-clear when context grows past the dismissal anchor.
  if (currentTokens >= rec.suppressedAtTokens + SUPPRESSION_RESET_DELTA) {
    SUPPRESSION.delete(sessionId);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Decision: which event (if any) should the query loop emit?
// ---------------------------------------------------------------------------

export type WarningEmission =
  | { kind: 'none' }
  | { kind: 'warning'; state: ExtendedWarningState }
  | { kind: 'error'; state: ExtendedWarningState };

export function decideWarningEmission(
  sessionId: string,
  state: ExtendedWarningState,
): WarningEmission {
  if (state.isAboveErrorThreshold) {
    return { kind: 'error', state };
  }
  if (
    state.isAboveWarningThreshold &&
    !isCompactWarningSuppressed(sessionId, state.currentTokens)
  ) {
    return { kind: 'warning', state };
  }
  return { kind: 'none' };
}
