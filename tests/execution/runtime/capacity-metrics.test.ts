/**
 * TDD: Tests for CapacityMetricsCollector (Phase 9D).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CapacityMetricsCollector } from '../../../src/execution/runtime/capacity-metrics';

describe('CapacityMetricsCollector', () => {
  it('initializes with correct slots_total and zero counters', () => {
    const collector = new CapacityMetricsCollector(5);
    const snap = collector.snapshot();
    assert.equal(snap.slots_total, 5);
    assert.equal(snap.slots_used, 0);
    assert.equal(snap.slots_available, 5);
    assert.equal(snap.wake_count, 0);
    assert.equal(snap.polls_skipped, 0);
  });

  it('updateSlots reflects in snapshot', () => {
    const collector = new CapacityMetricsCollector(5);
    collector.updateSlots(3);
    const snap = collector.snapshot();
    assert.equal(snap.slots_used, 3);
    assert.equal(snap.slots_available, 2);
  });

  it('updateSlots can change total', () => {
    const collector = new CapacityMetricsCollector(3);
    collector.updateSlots(1, 10);
    const snap = collector.snapshot();
    assert.equal(snap.slots_total, 10);
    assert.equal(snap.slots_used, 1);
    assert.equal(snap.slots_available, 9);
  });

  it('recordWake increments wake_count and stores event', () => {
    const collector = new CapacityMetricsCollector(3);
    collector.recordWake('signal');
    collector.recordWake('timer');
    assert.equal(collector.wakeCount, 2);
    assert.equal(collector.recentWakes().length, 2);
    assert.equal(collector.recentWakes()[0].trigger, 'signal');
    assert.equal(collector.recentWakes()[1].trigger, 'timer');
  });

  it('recordPollSkipped increments polls_skipped', () => {
    const collector = new CapacityMetricsCollector(3);
    collector.recordPollSkipped();
    collector.recordPollSkipped();
    assert.equal(collector.pollsSkipped, 2);
    assert.equal(collector.snapshot().polls_skipped, 2);
  });

  it('trims recent wakes to maxRecentWakes', () => {
    const collector = new CapacityMetricsCollector(3, 2);
    collector.recordWake('signal');
    collector.recordWake('timer');
    collector.recordWake('config-reload');
    assert.equal(collector.recentWakes().length, 2);
    assert.equal(collector.recentWakes()[0].trigger, 'timer');
    assert.equal(collector.recentWakes()[1].trigger, 'config-reload');
  });

  it('snapshot returns independent copy each time', () => {
    const collector = new CapacityMetricsCollector(3);
    const snap1 = collector.snapshot();
    collector.recordWake('signal');
    const snap2 = collector.snapshot();
    assert.equal(snap1.wake_count, 0);
    assert.equal(snap2.wake_count, 1);
  });
});
