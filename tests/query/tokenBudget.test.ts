import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBudgetTracker,
  checkTokenBudget,
  getBudgetContinuationMessage,
  COMPLETION_THRESHOLD,
  DIMINISHING_THRESHOLD,
} from '../../src/query/tokenBudget.js';
import type { BudgetTracker, ContinueDecision, StopDecision } from '../../src/query/tokenBudget.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asContinue(d: { action: string }): ContinueDecision {
  assert.equal(d.action, 'continue');
  return d as ContinueDecision;
}

function asStop(d: { action: string }): StopDecision {
  assert.equal(d.action, 'stop');
  return d as StopDecision;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenBudget', () => {
  // -- Constants ----------------------------------------------------------

  it('should export COMPLETION_THRESHOLD as 0.9', () => {
    assert.equal(COMPLETION_THRESHOLD, 0.9);
  });

  it('should export DIMINISHING_THRESHOLD as 500', () => {
    assert.equal(DIMINISHING_THRESHOLD, 500);
  });

  // -- createBudgetTracker ------------------------------------------------

  describe('createBudgetTracker', () => {
    it('should initialise with zero counts', () => {
      const t = createBudgetTracker();
      assert.equal(t.continuationCount, 0);
      assert.equal(t.lastDeltaTokens, 0);
      assert.equal(t.lastGlobalTurnTokens, 0);
      assert.ok(t.startedAt <= Date.now());
    });
  });

  // -- checkTokenBudget: continue -----------------------------------------

  describe('checkTokenBudget — continue', () => {
    let tracker: BudgetTracker;

    beforeEach(() => {
      tracker = createBudgetTracker();
    });

    it('should continue when under 90% threshold', () => {
      const d = asContinue(checkTokenBudget(tracker, undefined, 100_000, 50_000));
      assert.equal(d.pct, 50);
      assert.equal(d.continuationCount, 1);
      assert.ok(d.nudgeMessage.includes('50%'));
    });

    it('should continue at exactly 89% (below threshold)', () => {
      const d = asContinue(checkTokenBudget(tracker, undefined, 100_000, 89_000));
      assert.equal(d.pct, 89);
    });

    it('should increment continuationCount on each continue', () => {
      checkTokenBudget(tracker, undefined, 100_000, 30_000);
      assert.equal(tracker.continuationCount, 1);
      checkTokenBudget(tracker, undefined, 100_000, 50_000);
      assert.equal(tracker.continuationCount, 2);
      checkTokenBudget(tracker, undefined, 100_000, 70_000);
      assert.equal(tracker.continuationCount, 3);
    });

    it('should track lastDeltaTokens correctly', () => {
      checkTokenBudget(tracker, undefined, 100_000, 30_000);
      assert.equal(tracker.lastDeltaTokens, 30_000);
      assert.equal(tracker.lastGlobalTurnTokens, 30_000);

      checkTokenBudget(tracker, undefined, 100_000, 50_000);
      assert.equal(tracker.lastDeltaTokens, 20_000);
      assert.equal(tracker.lastGlobalTurnTokens, 50_000);
    });
  });

  // -- checkTokenBudget: stop (threshold) ---------------------------------

  describe('checkTokenBudget — stop on threshold', () => {
    let tracker: BudgetTracker;

    beforeEach(() => {
      tracker = createBudgetTracker();
    });

    it('should stop when over 90% threshold', () => {
      const d = asStop(checkTokenBudget(tracker, undefined, 100_000, 95_000));
      // No prior continuations, so completionEvent is null
      assert.equal(d.completionEvent, null);
    });

    it('should stop at exactly 90% (at threshold)', () => {
      const d = asStop(checkTokenBudget(tracker, undefined, 100_000, 90_000));
      assert.equal(d.completionEvent, null);
    });

    it('should emit completionEvent when continuations occurred', () => {
      // First call: under threshold, will continue
      checkTokenBudget(tracker, undefined, 100_000, 50_000);
      assert.equal(tracker.continuationCount, 1);

      // Second call: over threshold, should stop with event
      const d = asStop(checkTokenBudget(tracker, undefined, 100_000, 95_000));
      assert.ok(d.completionEvent !== null);
      assert.equal(d.completionEvent!.continuationCount, 1);
      assert.equal(d.completionEvent!.pct, 95);
      assert.equal(d.completionEvent!.turnTokens, 95_000);
      assert.equal(d.completionEvent!.budget, 100_000);
      assert.equal(d.completionEvent!.diminishingReturns, false);
      assert.ok(d.completionEvent!.durationMs >= 0);
    });
  });

  // -- checkTokenBudget: diminishing returns ------------------------------

  describe('checkTokenBudget — diminishing returns', () => {
    it('should detect diminishing returns after 3+ continuations', () => {
      const tracker = createBudgetTracker();
      tracker.continuationCount = 4;
      tracker.lastDeltaTokens = 200;
      tracker.lastGlobalTurnTokens = 49_800;

      const d = asStop(checkTokenBudget(tracker, undefined, 100_000, 50_100));
      assert.ok(d.completionEvent !== null);
      assert.equal(d.completionEvent!.diminishingReturns, true);
    });

    it('should NOT flag diminishing with fewer than 3 continuations', () => {
      const tracker = createBudgetTracker();
      tracker.continuationCount = 2;
      tracker.lastDeltaTokens = 200;
      tracker.lastGlobalTurnTokens = 49_800;

      // Under threshold + not enough continuations for diminishing check
      const d = asContinue(checkTokenBudget(tracker, undefined, 100_000, 50_100));
      assert.equal(d.action, 'continue');
    });

    it('should NOT flag diminishing when delta is large', () => {
      const tracker = createBudgetTracker();
      tracker.continuationCount = 4;
      tracker.lastDeltaTokens = 200;
      tracker.lastGlobalTurnTokens = 40_000;

      // delta = 50_000 - 40_000 = 10_000 (well above threshold)
      const d = asContinue(checkTokenBudget(tracker, undefined, 100_000, 50_000));
      assert.equal(d.action, 'continue');
    });
  });

  // -- checkTokenBudget: skip conditions ----------------------------------

  describe('checkTokenBudget — skip conditions', () => {
    let tracker: BudgetTracker;

    beforeEach(() => {
      tracker = createBudgetTracker();
    });

    it('should skip for subagents (agentId set)', () => {
      const d = asStop(checkTokenBudget(tracker, 'agent-123', 100_000, 50_000));
      assert.equal(d.completionEvent, null);
    });

    it('should skip when budget is null', () => {
      const d = asStop(checkTokenBudget(tracker, undefined, null, 50_000));
      assert.equal(d.completionEvent, null);
    });

    it('should skip when budget is 0', () => {
      const d = asStop(checkTokenBudget(tracker, undefined, 0, 50_000));
      assert.equal(d.completionEvent, null);
    });

    it('should skip when budget is negative', () => {
      const d = asStop(checkTokenBudget(tracker, undefined, -100, 50_000));
      assert.equal(d.completionEvent, null);
    });
  });

  // -- getBudgetContinuationMessage ---------------------------------------

  describe('getBudgetContinuationMessage', () => {
    it('should format the nudge message correctly', () => {
      const msg = getBudgetContinuationMessage(50, 50_000, 100_000);
      assert.ok(msg.includes('50%'));
      assert.ok(msg.includes('50,000'));
      assert.ok(msg.includes('100,000'));
      assert.ok(msg.includes('Continue working'));
    });
  });
});
