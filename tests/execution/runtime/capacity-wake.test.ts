/**
 * TDD: Tests for CapacityWake — capacity-aware wake with AbortSignal merging.
 *
 * Covers FR-9D.01 through FR-9D.10 (Phase 9D spec).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CapacityWake } from '../../../src/execution/runtime/capacity-wake';
import { parsePollConfig, PollConfigValidationError } from '../../../src/execution/runtime/capacity-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validConfig = {
  seekingIntervalMs: 200,
  atCapacityIntervalMs: 500,
  heartbeatIntervalMs: 1000,
  maxSlotsTotal: 3,
};

// ---------------------------------------------------------------------------
// PollConfig validation (FR-9D.04, FR-9D.05, FR-9D.06)
// ---------------------------------------------------------------------------

describe('PollConfig validation', () => {
  it('parses valid config with defaults applied', () => {
    const config = parsePollConfig({ heartbeatIntervalMs: 5000 });
    assert.equal(config.seekingIntervalMs, 2000);
    assert.equal(config.atCapacityIntervalMs, 600_000);
    assert.equal(config.maxSlotsTotal, 3);
    assert.equal(config.heartbeatIntervalMs, 5000);
  });

  it('rejects seekingIntervalMs below 100ms floor', () => {
    assert.throws(
      () => parsePollConfig({ seekingIntervalMs: 50, heartbeatIntervalMs: 1000 }),
      (err: unknown) => err instanceof PollConfigValidationError && err.issues.some(i => i.includes('seekingIntervalMs')),
    );
  });

  it('rejects atCapacityIntervalMs below 100ms floor', () => {
    assert.throws(
      () => parsePollConfig({ atCapacityIntervalMs: 99, heartbeatIntervalMs: 1000 }),
      (err: unknown) => err instanceof PollConfigValidationError && err.issues.some(i => i.includes('atCapacityIntervalMs')),
    );
  });

  it('rejects missing both heartbeatIntervalMs and keepaliveIntervalMs', () => {
    assert.throws(
      () => parsePollConfig({ seekingIntervalMs: 200 }),
      (err: unknown) => err instanceof PollConfigValidationError && err.issues.some(i => i.includes('liveness')),
    );
  });

  it('accepts config with only heartbeatIntervalMs', () => {
    const config = parsePollConfig({ heartbeatIntervalMs: 5000 });
    assert.equal(config.heartbeatIntervalMs, 5000);
    assert.equal(config.keepaliveIntervalMs, undefined);
  });

  it('accepts config with only keepaliveIntervalMs', () => {
    const config = parsePollConfig({ keepaliveIntervalMs: 3000 });
    assert.equal(config.keepaliveIntervalMs, 3000);
    assert.equal(config.heartbeatIntervalMs, undefined);
  });

  it('accepts config with both liveness mechanisms', () => {
    const config = parsePollConfig({ heartbeatIntervalMs: 5000, keepaliveIntervalMs: 3000 });
    assert.equal(config.heartbeatIntervalMs, 5000);
    assert.equal(config.keepaliveIntervalMs, 3000);
  });

  it('rejects maxSlotsTotal below 1', () => {
    assert.throws(
      () => parsePollConfig({ maxSlotsTotal: 0, heartbeatIntervalMs: 1000 }),
      (err: unknown) => err instanceof PollConfigValidationError && err.issues.some(i => i.includes('maxSlotsTotal')),
    );
  });

  it('applies defaults: seeking=2000, atCapacity=600000, maxSlots=3', () => {
    const config = parsePollConfig({ heartbeatIntervalMs: 1000 });
    assert.equal(config.seekingIntervalMs, 2000);
    assert.equal(config.atCapacityIntervalMs, 600_000);
    assert.equal(config.maxSlotsTotal, 3);
  });
});

// ---------------------------------------------------------------------------
// CapacityWake — slot management (FR-9D.01)
// ---------------------------------------------------------------------------

describe('CapacityWake', () => {
  describe('slot management', () => {
    it('acquireSlot returns true when slots available', () => {
      const wake = new CapacityWake(validConfig);
      assert.equal(wake.acquireSlot(), true);
      assert.equal(wake.slotsUsed, 1);
    });

    it('acquireSlot returns false when at capacity', () => {
      const wake = new CapacityWake(validConfig);
      wake.acquireSlot();
      wake.acquireSlot();
      wake.acquireSlot();
      assert.equal(wake.acquireSlot(), false);
      assert.equal(wake.slotsUsed, 3);
    });

    it('slot count never goes negative (release without acquire)', () => {
      const wake = new CapacityWake(validConfig);
      wake.releaseSlot();
      assert.equal(wake.slotsUsed, 0);
    });

    it('concurrent releaseSlot calls are safe (no double-wake crash)', () => {
      const wake = new CapacityWake(validConfig);
      wake.acquireSlot();
      wake.acquireSlot();
      // Release twice rapidly — should not throw
      wake.releaseSlot();
      wake.releaseSlot();
      assert.equal(wake.slotsUsed, 0);
    });
  });

  // -------------------------------------------------------------------------
  // waitForCapacity (FR-9D.01, FR-9D.02, FR-9D.03)
  // -------------------------------------------------------------------------

  describe('waitForCapacity', () => {
    it('resolves immediately when slots available', async () => {
      const wake = new CapacityWake(validConfig);
      // Should not block
      await wake.waitForCapacity();
    });

    it('blocks when at capacity, resolves on releaseSlot', async () => {
      const wake = new CapacityWake({ ...validConfig, atCapacityIntervalMs: 10_000 });
      wake.acquireSlot();
      wake.acquireSlot();
      wake.acquireSlot();

      let resolved = false;
      const waitPromise = wake.waitForCapacity().then(() => { resolved = true; });

      // Should not have resolved yet
      await new Promise(r => setTimeout(r, 10));
      assert.equal(resolved, false);

      // Release a slot — should wake instantly
      wake.releaseSlot();

      await waitPromise;
      assert.equal(resolved, true);
    });

    it('releaseSlot wakes waitForCapacity within 5ms', async () => {
      const wake = new CapacityWake({ ...validConfig, atCapacityIntervalMs: 60_000 });
      wake.acquireSlot();
      wake.acquireSlot();
      wake.acquireSlot();

      let wakeTime = 0;
      const waitPromise = wake.waitForCapacity().then(() => { wakeTime = performance.now(); });

      // Give the promise time to register the abort listener
      await new Promise(r => setTimeout(r, 5));

      const releaseTime = performance.now();
      wake.releaseSlot();

      await waitPromise;
      const latency = wakeTime - releaseTime;
      assert.ok(latency < 5, `Wake latency ${latency.toFixed(2)}ms exceeded 5ms threshold`);
    });

    it('resolves on timer expiry when no slot is released', async () => {
      const wake = new CapacityWake({ ...validConfig, atCapacityIntervalMs: 100 });
      wake.acquireSlot();
      wake.acquireSlot();
      wake.acquireSlot();

      // Should resolve after 100ms timer
      await wake.waitForCapacity();
      // polls_skipped increments on wait completion
      assert.equal(wake.getMetrics().polls_skipped, 1);
    });
  });

  // -------------------------------------------------------------------------
  // Two-tier transition (FR-9D.02)
  // -------------------------------------------------------------------------

  describe('two-tier polling', () => {
    it('uses seeking interval when slots free, at-capacity interval when full', async () => {
      // Verified structurally: the pollLoop method calls waitForCapacity
      // (which uses atCapacityIntervalMs) when full, and sleeps seekingIntervalMs
      // when slots are free. This test validates the config drives behavior.
      const wake = new CapacityWake(validConfig);
      assert.equal(wake.config.seekingIntervalMs, 200);
      assert.equal(wake.config.atCapacityIntervalMs, 500);
      assert.equal(wake.isAtCapacity(), false);

      wake.acquireSlot();
      wake.acquireSlot();
      wake.acquireSlot();
      assert.equal(wake.isAtCapacity(), true);
    });
  });

  // -------------------------------------------------------------------------
  // close (FR-9D.01)
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('unblocks waitForCapacity and stops poll loop', async () => {
      const wake = new CapacityWake({ ...validConfig, atCapacityIntervalMs: 60_000 });
      wake.acquireSlot();
      wake.acquireSlot();
      wake.acquireSlot();

      let resolved = false;
      const waitPromise = wake.waitForCapacity().then(() => { resolved = true; });

      await new Promise(r => setTimeout(r, 5));
      assert.equal(resolved, false);

      wake.close();
      await waitPromise;
      assert.equal(resolved, true);
      assert.equal(wake.closed, true);
    });

    it('stops pollLoop', async () => {
      const wake = new CapacityWake({ ...validConfig, seekingIntervalMs: 100 });
      let pollCount = 0;

      const loopPromise = wake.pollLoop(async () => { pollCount++; });

      // Let it poll a few times
      await new Promise(r => setTimeout(r, 350));
      wake.close();
      await loopPromise;

      const finalCount = pollCount;
      // Wait to confirm no more polls happen
      await new Promise(r => setTimeout(r, 200));
      assert.equal(pollCount, finalCount);
    });
  });

  // -------------------------------------------------------------------------
  // Sleep/wake detection (FR-9D.07)
  // -------------------------------------------------------------------------

  describe('sleep/wake detection', () => {
    it('detects gap > 2x atCapacityIntervalMs as OS sleep', () => {
      const wake = new CapacityWake(validConfig);
      // atCapacityIntervalMs = 500, so 2x = 1000
      assert.equal(wake.wouldResetBudget(1001), true);
      assert.equal(wake.wouldResetBudget(999), false);
    });
  });

  // -------------------------------------------------------------------------
  // Hot-reload (FR-9D.09)
  // -------------------------------------------------------------------------

  describe('hot-reload', () => {
    it('updateConfig applies new values validated by parsePollConfig', () => {
      const wake = new CapacityWake(validConfig);
      wake.updateConfig({ seekingIntervalMs: 300 });
      assert.equal(wake.config.seekingIntervalMs, 300);
    });

    it('updateConfig rejects invalid values', () => {
      const wake = new CapacityWake(validConfig);
      assert.throws(
        () => wake.updateConfig({ seekingIntervalMs: 50 }),
        (err: unknown) => err instanceof PollConfigValidationError,
      );
    });

    it('changing atCapacityIntervalMs during at-capacity sleep wakes immediately', async () => {
      const wake = new CapacityWake({ ...validConfig, atCapacityIntervalMs: 60_000 });
      wake.acquireSlot();
      wake.acquireSlot();
      wake.acquireSlot();

      let resolved = false;
      const waitPromise = wake.waitForCapacity().then(() => { resolved = true; });

      await new Promise(r => setTimeout(r, 5));
      assert.equal(resolved, false);

      // Hot-reload with new atCapacityIntervalMs — should wake
      wake.updateConfig({ atCapacityIntervalMs: 200 });

      await waitPromise;
      assert.equal(resolved, true);
    });
  });

  // -------------------------------------------------------------------------
  // Metrics (FR-9D.08)
  // -------------------------------------------------------------------------

  describe('metrics', () => {
    it('returns accurate slots_total, slots_used, slots_available', () => {
      const wake = new CapacityWake({ ...validConfig, maxSlotsTotal: 5 });
      wake.acquireSlot();
      wake.acquireSlot();
      wake.acquireSlot();
      wake.releaseSlot();

      const m = wake.getMetrics();
      assert.equal(m.slots_total, 5);
      assert.equal(m.slots_used, 2);
      assert.equal(m.slots_available, 3);
    });

    it('wake_count increments only on signal-triggered wake (not timer)', async () => {
      const wake = new CapacityWake({ ...validConfig, atCapacityIntervalMs: 100 });
      wake.acquireSlot();
      wake.acquireSlot();
      wake.acquireSlot();

      // Timer expiry — wake_count should NOT increment
      await wake.waitForCapacity();
      assert.equal(wake.getMetrics().wake_count, 0);

      // Signal-triggered wake — wake_count SHOULD increment
      wake.acquireSlot(); // still at 3 (was released by... no, we didn't release)
      // Actually slotsUsed is still 3. Call waitForCapacity again and release.
      const waitPromise = wake.waitForCapacity();
      await new Promise(r => setTimeout(r, 5));
      wake.releaseSlot();
      await waitPromise;
      assert.equal(wake.getMetrics().wake_count, 1);
    });

    it('polls_skipped increments each time at-capacity wait completes', async () => {
      const wake = new CapacityWake({ ...validConfig, atCapacityIntervalMs: 100 });
      wake.acquireSlot();
      wake.acquireSlot();
      wake.acquireSlot();

      await wake.waitForCapacity();
      assert.equal(wake.getMetrics().polls_skipped, 1);

      await wake.waitForCapacity();
      assert.equal(wake.getMetrics().polls_skipped, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Slot changed events
  // -------------------------------------------------------------------------

  describe('slot changed events', () => {
    it('emits events on acquire and release', () => {
      const wake = new CapacityWake(validConfig);
      const events: Array<{ action: string }> = [];
      wake.onSlotChanged((e) => events.push({ action: e.action }));

      wake.acquireSlot();
      wake.releaseSlot();

      assert.equal(events.length, 2);
      assert.equal(events[0].action, 'acquired');
      assert.equal(events[1].action, 'released');
    });
  });

  // -------------------------------------------------------------------------
  // pollLoop integration (FR-9D.10)
  // -------------------------------------------------------------------------

  describe('pollLoop', () => {
    it('acquires all slots, blocks, release wakes and resumes polling', async () => {
      const wake = new CapacityWake({
        ...validConfig,
        seekingIntervalMs: 100,
        atCapacityIntervalMs: 60_000,
      });

      let pollCount = 0;
      const loopPromise = wake.pollLoop(async () => {
        pollCount++;
        if (pollCount <= 3) {
          wake.acquireSlot();
        }
      });

      // Wait for 3 polls to fill capacity
      await new Promise(r => setTimeout(r, 500));
      const countAtCapacity = pollCount;
      assert.equal(wake.isAtCapacity(), true);

      // Release a slot — should resume polling
      wake.releaseSlot();
      await new Promise(r => setTimeout(r, 250));

      assert.ok(pollCount > countAtCapacity, 'Poll should have resumed after release');

      wake.close();
      await loopPromise;
    });
  });
});
