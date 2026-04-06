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
} from '../src/execution/orchestrator/work-tracker';
import { createAgentTracker } from '../src/execution/runtime/agent-tracker';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkTracker', () => {
  describe('createWorkTracker()', () => {
    it('creates a tracker instance', () => {
      const tracker = createWorkTracker();
      assert.ok(tracker);
      assert.equal(typeof tracker.start, 'function');
    });
  });

  describe('start()', () => {
    it('registers a new work item as running', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');

      const active = tracker.listActive();
      const state = active.find(s => s.planId === 'plan-001');
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

  describe('complete()', () => {
    it('marks work as completed', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');
      tracker.complete('plan-001');

      const active = tracker.listActive();
      assert.equal(active.length, 0);
    });
  });

  describe('fail()', () => {
    it('marks work as failed with reason', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');
      tracker.fail('plan-001', 'Gate check failed on refinement');

      const active = tracker.listActive();
      assert.equal(active.length, 0);
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

  describe('unknown planId errors', () => {
    it('complete throws for unknown plan', () => {
      const tracker = createWorkTracker();
      assert.throws(() => {
        tracker.complete('nonexistent');
      }, /not tracked/);
    });

    it('fail throws for unknown plan', () => {
      const tracker = createWorkTracker();
      assert.throws(() => {
        tracker.fail('nonexistent', 'reason');
      }, /not tracked/);
    });
  });

  describe('getAgentsByPlan() — AgentTracker delegation', () => {
    it('returns empty array when no agentTracker provided', () => {
      const tracker = createWorkTracker();
      const agents = tracker.getAgentsByPlan('plan-001');
      assert.deepEqual(agents, []);
    });

    it('returns empty array when agentTracker has no agents for the plan', () => {
      const agentTracker = createAgentTracker();
      const tracker = createWorkTracker({ agentTracker });
      const agents = tracker.getAgentsByPlan('plan-001');
      assert.deepEqual(agents, []);
    });

    it('delegates to agentTracker and returns per-agent state', () => {
      const agentTracker = createAgentTracker();
      agentTracker.spawn('exec-1', 'plan-001', 'coder', 'sparc-coder', 'refinement');
      agentTracker.spawn('exec-2', 'plan-001', 'tester', 'tester', 'completion');
      agentTracker.touch('exec-1', 200);
      agentTracker.complete('exec-2', { input: 100, output: 50 });

      const tracker = createWorkTracker({ agentTracker });
      const agents = tracker.getAgentsByPlan('plan-001');

      assert.equal(agents.length, 2);
      const coder = agents.find(a => a.agentRole === 'coder');
      const tester = agents.find(a => a.agentRole === 'tester');

      assert.ok(coder);
      assert.equal(coder!.status, 'running');
      assert.equal(coder!.bytesReceived, 200);

      assert.ok(tester);
      assert.equal(tester!.status, 'completed');
      assert.deepEqual(tester!.tokenUsage, { input: 100, output: 50 });
    });

    it('only returns agents for the requested plan, not other plans', () => {
      const agentTracker = createAgentTracker();
      agentTracker.spawn('exec-1', 'plan-001', 'coder', 'coder', 'refinement');
      agentTracker.spawn('exec-2', 'plan-002', 'tester', 'tester', 'completion');

      const tracker = createWorkTracker({ agentTracker });
      const agents = tracker.getAgentsByPlan('plan-001');

      assert.equal(agents.length, 1);
      assert.equal(agents[0].planId, 'plan-001');
    });

    it('backward compatible — createWorkTracker() without opts still works', () => {
      const tracker = createWorkTracker();
      tracker.start('plan-001', 'work-001');
      tracker.complete('plan-001');
      assert.deepEqual(tracker.getAgentsByPlan('plan-001'), []);
    });
  });
});
