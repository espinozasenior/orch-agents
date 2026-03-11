/**
 * TDD: Tests for WorkTracker — tracks work item execution state.
 *
 * RED phase: WorkTracker maintains state for active work items,
 * recording phase progress, start/end times, and final outcome.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkTracker,
  type WorkTracker,
  type WorkItemState,
} from '../src/execution/work-tracker';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkTracker', () => {
  describe('createWorkTracker()', () => {
    it('creates a tracker instance', () => {
      const tracker = createWorkTracker();
      assert.ok(tracker);
      assert.equal(typeof tracker.start, 'function');
      assert.equal(typeof tracker.getState, 'function');
    });
  });

  describe('start()', () => {
    it('registers a new work item as running', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');

      const state = tracker.getState('plan-001');
      assert.ok(state);
      assert.equal(state!.planId, 'plan-001');
      assert.equal(state!.workItemId, 'work-001');
      assert.equal(state!.status, 'running');
      assert.ok(state!.startedAt);
    });

    it('throws if plan already tracked', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');

      assert.throws(() => {
        tracker.start('plan-001', 'work-002');
      }, /already tracked/);
    });
  });

  describe('recordPhaseResult()', () => {
    it('adds phase result to tracked state', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');

      tracker.recordPhaseResult('plan-001', {
        phaseId: 'phase-1',
        planId: 'plan-001',
        phaseType: 'refinement',
        status: 'completed',
        artifacts: [],
        metrics: { duration: 100, agentUtilization: 0.8, modelCost: 0.01 },
      });

      const state = tracker.getState('plan-001')!;
      assert.equal(state.phaseResults.length, 1);
      assert.equal(state.phaseResults[0].phaseType, 'refinement');
    });

    it('accumulates multiple phase results', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');

      tracker.recordPhaseResult('plan-001', {
        phaseId: 'p1', planId: 'plan-001', phaseType: 'specification',
        status: 'completed', artifacts: [],
        metrics: { duration: 50, agentUtilization: 0.5, modelCost: 0.005 },
      });
      tracker.recordPhaseResult('plan-001', {
        phaseId: 'p2', planId: 'plan-001', phaseType: 'refinement',
        status: 'completed', artifacts: [],
        metrics: { duration: 100, agentUtilization: 0.8, modelCost: 0.01 },
      });

      const state = tracker.getState('plan-001')!;
      assert.equal(state.phaseResults.length, 2);
    });
  });

  describe('complete()', () => {
    it('marks work as completed', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');
      tracker.complete('plan-001');

      const state = tracker.getState('plan-001')!;
      assert.equal(state.status, 'completed');
      assert.ok(state.completedAt);
    });

    it('calculates total duration', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');

      // Small delay to ensure non-zero duration
      tracker.recordPhaseResult('plan-001', {
        phaseId: 'p1', planId: 'plan-001', phaseType: 'refinement',
        status: 'completed', artifacts: [],
        metrics: { duration: 100, agentUtilization: 0.8, modelCost: 0.01 },
      });

      tracker.complete('plan-001');
      const state = tracker.getState('plan-001')!;
      assert.ok(state.totalDuration >= 0);
    });
  });

  describe('fail()', () => {
    it('marks work as failed with reason', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');
      tracker.fail('plan-001', 'Gate check failed on refinement');

      const state = tracker.getState('plan-001')!;
      assert.equal(state.status, 'failed');
      assert.equal(state.failureReason, 'Gate check failed on refinement');
      assert.ok(state.completedAt);
    });
  });

  describe('listActive()', () => {
    it('returns only running work items', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');
      tracker.start('plan-002', 'work-002');
      tracker.complete('plan-001');

      const active = tracker.listActive();
      assert.equal(active.length, 1);
      assert.equal(active[0].planId, 'plan-002');
    });
  });

  describe('getState() for unknown plan', () => {
    it('returns undefined', () => {
      const tracker = createWorkTracker();
      assert.equal(tracker.getState('nonexistent'), undefined);
    });
  });

  describe('cleanup()', () => {
    it('removes completed work items older than threshold', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');
      tracker.complete('plan-001');

      // Before cleanup, state exists
      assert.ok(tracker.getState('plan-001'));

      // Cleanup with 0ms threshold removes everything completed
      tracker.cleanup(0);
      assert.equal(tracker.getState('plan-001'), undefined);
    });

    it('keeps running work items during cleanup', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');
      tracker.start('plan-002', 'work-002');
      tracker.complete('plan-001');

      tracker.cleanup(0);
      assert.equal(tracker.getState('plan-001'), undefined);
      assert.ok(tracker.getState('plan-002')); // still running
    });
  });
});
