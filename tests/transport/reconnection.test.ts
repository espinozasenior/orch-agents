import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReconnectionState,
  shouldReconnect,
  nextBackoff,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  BUDGET_MS,
  SLEEP_WAKE_THRESHOLD_MS,
} from '../../src/transport/reconnection.js';

describe('Reconnection', () => {
  describe('exponential backoff', () => {
    it('doubles from 1s to 30s cap', () => {
      const state = createReconnectionState(0);
      // Use fixed random to eliminate jitter: random() = 0.5 → jitter = 0
      const fixedRandom = () => 0.5;

      const delays: number[] = [];
      for (let i = 0; i < 8; i++) {
        delays.push(nextBackoff(state, 0, fixedRandom));
      }

      // With jitter=0: 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000
      assert.equal(delays[0], 1000);
      assert.equal(delays[1], 2000);
      assert.equal(delays[2], 4000);
      assert.equal(delays[3], 8000);
      assert.equal(delays[4], 16000);
      assert.equal(delays[5], 30000); // capped
      assert.equal(delays[6], 30000); // stays capped
    });

    it('jitter stays within +/-20% of current backoff', () => {
      const state = createReconnectionState(0);

      // Run many iterations and check bounds
      for (let i = 0; i < 100; i++) {
        const s = createReconnectionState(0);
        const delay = nextBackoff(s, 0);
        // First backoff is 1000 +/- 20% = [800, 1200]
        assert.ok(delay >= 800, `delay ${delay} < 800`);
        assert.ok(delay <= 1200, `delay ${delay} > 1200`);
      }
    });
  });

  describe('budget exhaustion', () => {
    it('returns false after 10 minutes', () => {
      const now = 0;
      const state = createReconnectionState(now);
      state.lastAttemptTime = now; // prevent sleep/wake detection

      // Just under budget — should reconnect
      const almostExpired = now + BUDGET_MS - 1;
      state.lastAttemptTime = almostExpired; // keep gap small
      assert.equal(shouldReconnect(state, 1006, almostExpired), true);

      // At budget — should not reconnect
      const expired = now + BUDGET_MS;
      state.lastAttemptTime = expired; // keep gap small
      assert.equal(shouldReconnect(state, 1006, expired), false);
    });
  });

  describe('permanent close codes', () => {
    it('code 4001 returns false immediately', () => {
      const state = createReconnectionState(0);
      assert.equal(shouldReconnect(state, 4001, 0), false);
    });

    it('code 1000 (normal) returns false', () => {
      const state = createReconnectionState(0);
      assert.equal(shouldReconnect(state, 1000, 0), false);
    });

    it('code 1001 (going away) returns false', () => {
      const state = createReconnectionState(0);
      assert.equal(shouldReconnect(state, 1001, 0), false);
    });

    it('code 4000 (app fatal min) returns false', () => {
      const state = createReconnectionState(0);
      assert.equal(shouldReconnect(state, 4000, 0), false);
    });

    it('code 4099 (app fatal max) returns false', () => {
      const state = createReconnectionState(0);
      assert.equal(shouldReconnect(state, 4099, 0), false);
    });

    it('code 1006 (abnormal) is treated as retriable', () => {
      const state = createReconnectionState(0);
      assert.equal(shouldReconnect(state, 1006, 0), true);
    });

    it('code 4100 (above fatal range) is treated as retriable', () => {
      const state = createReconnectionState(0);
      assert.equal(shouldReconnect(state, 4100, 0), true);
    });
  });

  describe('sleep/wake detection', () => {
    it('gap >= 60s resets budget to full 10 minutes', () => {
      const start = 0;
      const state = createReconnectionState(start);

      // Simulate: 5 minutes pass normally, then a 61-second gap (sleep)
      state.lastAttemptTime = start + 300_000; // 5 min in
      state.budgetStartTime = start;
      state.currentBackoffMs = 16_000; // backed off a lot

      const afterSleep = start + 300_000 + SLEEP_WAKE_THRESHOLD_MS;
      const result = shouldReconnect(state, 1006, afterSleep);

      assert.equal(result, true);
      // Budget should be reset: budgetStartTime = afterSleep
      assert.equal(state.budgetStartTime, afterSleep);
      // Backoff should reset to base
      assert.equal(state.currentBackoffMs, BACKOFF_BASE_MS);
    });

    it('normal gap (< 60s) does not reset budget', () => {
      const start = 0;
      const state = createReconnectionState(start);
      state.lastAttemptTime = start + 10_000;
      state.currentBackoffMs = 8_000;

      const normalGap = start + 10_000 + 30_000; // 30s gap — under threshold
      shouldReconnect(state, 1006, normalGap);

      // budgetStartTime should NOT have changed
      assert.equal(state.budgetStartTime, start);
      // currentBackoffMs should NOT have reset
      assert.equal(state.currentBackoffMs, 8_000);
    });
  });

  describe('constants', () => {
    it('has correct values', () => {
      assert.equal(BACKOFF_BASE_MS, 1_000);
      assert.equal(BACKOFF_CAP_MS, 30_000);
      assert.equal(BUDGET_MS, 600_000);
      assert.equal(SLEEP_WAKE_THRESHOLD_MS, 60_000);
    });
  });
});
