/**
 * TDD: Tests for AgentTracker — per-agent execution state tracking.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTracker } from '../../src/execution/agent-tracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAndSpawn() {
  const tracker = createAgentTracker();
  tracker.spawn('exec-1', 'plan-1', 'coder', 'sparc-coder', 'refinement');
  return tracker;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentTracker', () => {
  describe('spawn', () => {
    it('creates agent with spawned status', () => {
      const tracker = createAndSpawn();
      const agent = tracker.getAgent('exec-1');
      assert.ok(agent);
      assert.equal(agent!.status, 'spawned');
      assert.equal(agent!.planId, 'plan-1');
      assert.equal(agent!.agentRole, 'coder');
      assert.equal(agent!.agentType, 'sparc-coder');
      assert.equal(agent!.phaseType, 'refinement');
      assert.equal(agent!.bytesReceived, 0);
      assert.equal(agent!.chunksReceived, 0);
    });

    it('throws on duplicate execId', () => {
      const tracker = createAndSpawn();
      assert.throws(() => {
        tracker.spawn('exec-1', 'plan-1', 'tester', 'tester', 'completion');
      }, /already tracked/);
    });
  });

  describe('touch', () => {
    it('transitions to running and updates lastActivity', () => {
      const tracker = createAndSpawn();
      tracker.touch('exec-1', 100);
      const agent = tracker.getAgent('exec-1')!;
      assert.equal(agent.status, 'running');
      assert.equal(agent.bytesReceived, 100);
      assert.equal(agent.chunksReceived, 1);
    });

    it('accumulates bytes across multiple touches', () => {
      const tracker = createAndSpawn();
      tracker.touch('exec-1', 50);
      tracker.touch('exec-1', 75);
      tracker.touch('exec-1', 25);
      const agent = tracker.getAgent('exec-1')!;
      assert.equal(agent.bytesReceived, 150);
      assert.equal(agent.chunksReceived, 3);
    });

    it('throws for unknown execId', () => {
      const tracker = createAgentTracker();
      assert.throws(() => tracker.touch('unknown'), /not tracked/);
    });
  });

  describe('complete', () => {
    it('transitions to completed with optional tokenUsage', () => {
      const tracker = createAndSpawn();
      tracker.touch('exec-1', 100);
      tracker.complete('exec-1', { input: 500, output: 200 });
      const agent = tracker.getAgent('exec-1')!;
      assert.equal(agent.status, 'completed');
      assert.ok(agent.completedAt);
      assert.deepEqual(agent.tokenUsage, { input: 500, output: 200 });
    });

    it('works without tokenUsage', () => {
      const tracker = createAndSpawn();
      tracker.complete('exec-1');
      const agent = tracker.getAgent('exec-1')!;
      assert.equal(agent.status, 'completed');
      assert.equal(agent.tokenUsage, undefined);
    });
  });

  describe('fail', () => {
    it('transitions to failed', () => {
      const tracker = createAndSpawn();
      tracker.fail('exec-1');
      assert.equal(tracker.getAgent('exec-1')!.status, 'failed');
      assert.ok(tracker.getAgent('exec-1')!.completedAt);
    });
  });

  describe('cancel', () => {
    it('transitions to cancelled', () => {
      const tracker = createAndSpawn();
      tracker.cancel('exec-1');
      assert.equal(tracker.getAgent('exec-1')!.status, 'cancelled');
      assert.ok(tracker.getAgent('exec-1')!.completedAt);
    });
  });

  describe('timeout', () => {
    it('transitions to timed-out', () => {
      const tracker = createAndSpawn();
      tracker.timeout('exec-1');
      assert.equal(tracker.getAgent('exec-1')!.status, 'timed-out');
    });
  });

  describe('recordSignal', () => {
    it('increments toolUseCount', () => {
      const tracker = createAndSpawn();
      tracker.recordSignal('exec-1', 'toolUse');
      tracker.recordSignal('exec-1', 'toolUse');
      assert.equal(tracker.getAgent('exec-1')!.parsedSignals.toolUseCount, 2);
    });

    it('sets thinkingDetected', () => {
      const tracker = createAndSpawn();
      tracker.recordSignal('exec-1', 'thinking');
      assert.equal(tracker.getAgent('exec-1')!.parsedSignals.thinkingDetected, true);
    });

    it('sets jsonDetected', () => {
      const tracker = createAndSpawn();
      tracker.recordSignal('exec-1', 'json');
      assert.equal(tracker.getAgent('exec-1')!.parsedSignals.jsonDetected, true);
    });
  });

  describe('getAgentsByPlan', () => {
    it('returns agents for a specific plan', () => {
      const tracker = createAgentTracker();
      tracker.spawn('exec-1', 'plan-1', 'coder', 'coder', 'refinement');
      tracker.spawn('exec-2', 'plan-1', 'tester', 'tester', 'completion');
      tracker.spawn('exec-3', 'plan-2', 'reviewer', 'reviewer', 'specification');

      const plan1Agents = tracker.getAgentsByPlan('plan-1');
      assert.equal(plan1Agents.length, 2);
      assert.ok(plan1Agents.some((a) => a.agentRole === 'coder'));
      assert.ok(plan1Agents.some((a) => a.agentRole === 'tester'));
    });

    it('returns empty array for unknown planId', () => {
      const tracker = createAgentTracker();
      assert.deepEqual(tracker.getAgentsByPlan('unknown'), []);
    });
  });

  describe('getStalled', () => {
    it('identifies agents with no recent activity', () => {
      const tracker = createAgentTracker();
      tracker.spawn('exec-1', 'plan-1', 'coder', 'coder', 'refinement');
      tracker.touch('exec-1', 10);

      // With a 0ms threshold, the agent should be stalled immediately
      const stalled = tracker.getStalled(0);
      assert.equal(stalled.length, 1);
      assert.equal(stalled[0].execId, 'exec-1');
    });

    it('excludes completed agents', () => {
      const tracker = createAndSpawn();
      tracker.complete('exec-1');
      const stalled = tracker.getStalled(0);
      assert.equal(stalled.length, 0);
    });

    it('excludes recently active agents with high threshold', () => {
      const tracker = createAndSpawn();
      tracker.touch('exec-1', 10);
      // 1 hour threshold — agent just touched, should not be stalled
      const stalled = tracker.getStalled(3_600_000);
      assert.equal(stalled.length, 0);
    });
  });

  describe('cleanup', () => {
    it('removes old completed agents', () => {
      const tracker = createAndSpawn();
      tracker.complete('exec-1');

      // With 0 maxAge, everything completed should be cleaned
      tracker.cleanup(0);
      assert.equal(tracker.getAgent('exec-1'), undefined);
      assert.deepEqual(tracker.getAgentsByPlan('plan-1'), []);
    });

    it('preserves running agents', () => {
      const tracker = createAndSpawn();
      tracker.touch('exec-1', 10);
      tracker.cleanup(0);
      assert.ok(tracker.getAgent('exec-1'));
    });
  });

  describe('touch — default bytes', () => {
    it('defaults bytesInChunk to 0 when not provided', () => {
      const tracker = createAndSpawn();
      tracker.touch('exec-1');
      const agent = tracker.getAgent('exec-1')!;
      assert.equal(agent.status, 'running');
      assert.equal(agent.bytesReceived, 0);
      assert.equal(agent.chunksReceived, 1);
    });
  });

  describe('error handling on unknown IDs', () => {
    it('fail() throws for unknown execId', () => {
      const tracker = createAgentTracker();
      assert.throws(() => tracker.fail('unknown'), /not tracked/);
    });

    it('cancel() throws for unknown execId', () => {
      const tracker = createAgentTracker();
      assert.throws(() => tracker.cancel('unknown'), /not tracked/);
    });

    it('timeout() throws for unknown execId', () => {
      const tracker = createAgentTracker();
      assert.throws(() => tracker.timeout('unknown'), /not tracked/);
    });

    it('complete() throws for unknown execId', () => {
      const tracker = createAgentTracker();
      assert.throws(() => tracker.complete('unknown'), /not tracked/);
    });

    it('recordSignal() throws for unknown execId', () => {
      const tracker = createAgentTracker();
      assert.throws(() => tracker.recordSignal('unknown', 'toolUse'), /not tracked/);
    });
  });

  describe('getAgent', () => {
    it('returns undefined for unknown execId', () => {
      const tracker = createAgentTracker();
      assert.equal(tracker.getAgent('nonexistent'), undefined);
    });
  });

  describe('getStalled — spawned status', () => {
    it('identifies spawned agents as stalled (not just running)', () => {
      const tracker = createAgentTracker();
      tracker.spawn('exec-1', 'plan-1', 'coder', 'coder', 'refinement');
      // Agent is spawned but never touched — should be considered stalled
      const stalled = tracker.getStalled(0);
      assert.equal(stalled.length, 1);
      assert.equal(stalled[0].status, 'spawned');
    });

    it('excludes failed agents from stalled', () => {
      const tracker = createAndSpawn();
      tracker.fail('exec-1');
      const stalled = tracker.getStalled(0);
      assert.equal(stalled.length, 0);
    });

    it('excludes cancelled agents from stalled', () => {
      const tracker = createAndSpawn();
      tracker.cancel('exec-1');
      const stalled = tracker.getStalled(0);
      assert.equal(stalled.length, 0);
    });

    it('excludes timed-out agents from stalled', () => {
      const tracker = createAndSpawn();
      tracker.timeout('exec-1');
      const stalled = tracker.getStalled(0);
      assert.equal(stalled.length, 0);
    });
  });

  describe('cleanup — plan index cleanup', () => {
    it('removes plan from index when all its agents are cleaned', () => {
      const tracker = createAgentTracker();
      tracker.spawn('e1', 'plan-1', 'coder', 'coder', 'refinement');
      tracker.complete('e1');
      tracker.cleanup(0);

      // After cleanup, getAgentsByPlan should return empty
      assert.deepEqual(tracker.getAgentsByPlan('plan-1'), []);
    });

    it('preserves plan index when only some agents are cleaned', () => {
      const tracker = createAgentTracker();
      tracker.spawn('e1', 'plan-1', 'coder', 'coder', 'refinement');
      tracker.spawn('e2', 'plan-1', 'tester', 'tester', 'completion');
      tracker.complete('e1');
      // e2 is still spawned (no completedAt), so not eligible for cleanup
      tracker.cleanup(0);

      const agents = tracker.getAgentsByPlan('plan-1');
      assert.equal(agents.length, 1);
      assert.equal(agents[0].execId, 'e2');
    });

    it('cleans up failed and cancelled agents too', () => {
      const tracker = createAgentTracker();
      tracker.spawn('e1', 'plan-1', 'coder', 'coder', 'refinement');
      tracker.spawn('e2', 'plan-1', 'tester', 'tester', 'completion');
      tracker.fail('e1');
      tracker.cancel('e2');
      tracker.cleanup(0);

      assert.equal(tracker.getAgent('e1'), undefined);
      assert.equal(tracker.getAgent('e2'), undefined);
      assert.deepEqual(tracker.getAgentsByPlan('plan-1'), []);
    });

    it('respects maxAgeMs threshold (keeps recent completions)', () => {
      const tracker = createAgentTracker();
      tracker.spawn('e1', 'plan-1', 'coder', 'coder', 'refinement');
      tracker.complete('e1');
      // Use a very large maxAge — nothing should be cleaned
      tracker.cleanup(999_999_999);
      assert.ok(tracker.getAgent('e1'));
    });
  });

  describe('spawn — plan index creation', () => {
    it('creates plan index entry for first agent in a plan', () => {
      const tracker = createAgentTracker();
      tracker.spawn('e1', 'plan-new', 'coder', 'coder', 'refinement');
      assert.equal(tracker.getAgentsByPlan('plan-new').length, 1);
    });

    it('appends to existing plan index for subsequent agents', () => {
      const tracker = createAgentTracker();
      tracker.spawn('e1', 'plan-1', 'coder', 'coder', 'refinement');
      tracker.spawn('e2', 'plan-1', 'tester', 'tester', 'completion');
      tracker.spawn('e3', 'plan-1', 'reviewer', 'reviewer', 'specification');
      assert.equal(tracker.getAgentsByPlan('plan-1').length, 3);
    });
  });

  describe('concurrent operations', () => {
    it('handles multiple agents across multiple plans', () => {
      const tracker = createAgentTracker();

      // Spawn agents across plans
      tracker.spawn('e1', 'p1', 'coder', 'coder', 'refinement');
      tracker.spawn('e2', 'p1', 'tester', 'tester', 'completion');
      tracker.spawn('e3', 'p2', 'reviewer', 'reviewer', 'specification');
      tracker.spawn('e4', 'p2', 'architect', 'architect', 'architecture');

      // Touch some
      tracker.touch('e1', 50);
      tracker.touch('e3', 30);

      // Complete/fail some
      tracker.complete('e2', { input: 100, output: 50 });
      tracker.fail('e4');

      // Verify states
      assert.equal(tracker.getAgent('e1')!.status, 'running');
      assert.equal(tracker.getAgent('e2')!.status, 'completed');
      assert.equal(tracker.getAgent('e3')!.status, 'running');
      assert.equal(tracker.getAgent('e4')!.status, 'failed');

      // Verify plan queries
      assert.equal(tracker.getAgentsByPlan('p1').length, 2);
      assert.equal(tracker.getAgentsByPlan('p2').length, 2);
    });
  });
});
