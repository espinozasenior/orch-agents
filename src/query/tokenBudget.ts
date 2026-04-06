/**
 * Token Budget Auto-Continue (Phase P3)
 *
 * Tracks token usage within a turn and decides whether the agent should
 * continue working or stop.  The algorithm mirrors Claude Code's original
 * tokenBudget.ts — O(1) per check, no token counting.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stop when the agent has consumed this fraction of its budget. */
export const COMPLETION_THRESHOLD = 0.9;

/** Minimum new tokens per check to avoid "diminishing returns" early stop. */
export const DIMINISHING_THRESHOLD = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BudgetTracker {
  continuationCount: number;
  lastDeltaTokens: number;
  lastGlobalTurnTokens: number;
  startedAt: number;
}

export interface CompletionEvent {
  continuationCount: number;
  pct: number;
  turnTokens: number;
  budget: number;
  diminishingReturns: boolean;
  durationMs: number;
}

export interface ContinueDecision {
  action: 'continue';
  nudgeMessage: string;
  continuationCount: number;
  pct: number;
}

export interface StopDecision {
  action: 'stop';
  completionEvent: CompletionEvent | null;
}

export type TokenBudgetDecision = ContinueDecision | StopDecision;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

export function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,
  globalTurnTokens: number,
): TokenBudgetDecision {
  // Skip for subagents or when there is no usable budget
  if (agentId || budget === null || budget <= 0) {
    return { action: 'stop', completionEvent: null };
  }

  const turnTokens = globalTurnTokens;
  const pct = Math.round((turnTokens / budget) * 100);
  const deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens;

  // Detect diminishing returns: 3+ continuations and last two deltas tiny
  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD;

  // Continue if under threshold and still making progress
  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount += 1;
    tracker.lastDeltaTokens = deltaSinceLastCheck;
    tracker.lastGlobalTurnTokens = globalTurnTokens;

    const nudgeMessage = getBudgetContinuationMessage(pct, turnTokens, budget);
    return {
      action: 'continue',
      nudgeMessage,
      continuationCount: tracker.continuationCount,
      pct,
    };
  }

  // Stop — emit completion event only if we ever continued
  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: 'stop',
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    };
  }

  return { action: 'stop', completionEvent: null };
}

// ---------------------------------------------------------------------------
// Nudge message formatter
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function getBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  return (
    `You have used ${pct}% of your token budget ` +
    `(${formatNumber(turnTokens)}/${formatNumber(budget)} tokens). ` +
    `Continue working on the task.`
  );
}
