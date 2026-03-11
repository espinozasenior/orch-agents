/**
 * TDD: Tests for PhaseRunner — the pluggable SPARC phase executor.
 *
 * RED phase: These tests define the contract for running individual
 * SPARC phases with agent coordination and quality gates.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlannedPhase, PhaseResult, WorkflowPlan } from '../src/types';
import {
  type PhaseRunner,
  type PhaseRunnerDeps,
  createPhaseRunner,
  type GateChecker,
} from '../src/execution/phase-runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-001',
    workItemId: 'work-001',
    methodology: 'sparc-partial',
    template: 'github-ops',
    topology: 'hierarchical',
    swarmStrategy: 'specialized',
    consensus: 'raft',
    maxAgents: 4,
    phases: [
      { type: 'specification', agents: ['architect'], gate: 'spec-approved', skippable: true },
      { type: 'refinement', agents: ['coder', 'tester'], gate: 'tests-pass', skippable: false },
      { type: 'completion', agents: ['reviewer'], gate: 'review-approved', skippable: false },
    ],
    agentTeam: [
      { role: 'lead', type: 'architect', tier: 3, required: true },
      { role: 'implementer', type: 'coder', tier: 3, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: false },
    ],
    estimatedDuration: 15,
    estimatedCost: 0.02,
    ...overrides,
  };
}

/** Mock gate checker that always passes. */
const passingGate: GateChecker = async () => ({ passed: true });

/** Mock gate checker that always fails. */
const failingGate: GateChecker = async () => ({
  passed: false,
  reason: 'Gate check failed',
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PhaseRunner', () => {
  describe('createPhaseRunner()', () => {
    it('returns a PhaseRunner object', () => {
      const runner = createPhaseRunner({
        gateChecker: passingGate,
      });
      assert.ok(runner);
      assert.equal(typeof runner.runPhase, 'function');
    });
  });

  describe('runPhase()', () => {
    it('returns a PhaseResult with completed status on success', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();
      const phase = plan.phases[1]; // refinement

      const result = await runner.runPhase(plan, phase);

      assert.equal(result.planId, 'plan-001');
      assert.equal(result.phaseType, 'refinement');
      assert.equal(result.status, 'completed');
      assert.ok(result.phaseId, 'Should have a phaseId');
      assert.ok(result.metrics.duration >= 0, 'Should have duration metric');
    });

    it('includes artifacts array (empty by default)', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();

      const result = await runner.runPhase(plan, plan.phases[1]);

      assert.ok(Array.isArray(result.artifacts));
    });

    it('returns failed status when gate check fails', async () => {
      const runner = createPhaseRunner({ gateChecker: failingGate });
      const plan = makePlan();

      const result = await runner.runPhase(plan, plan.phases[1]); // non-skippable

      assert.equal(result.status, 'failed');
    });

    it('returns skipped status for skippable phase with failing gate', async () => {
      const runner = createPhaseRunner({ gateChecker: failingGate });
      const plan = makePlan();
      const skippablePhase = plan.phases[0]; // specification (skippable)

      const result = await runner.runPhase(plan, skippablePhase);

      assert.equal(result.status, 'skipped');
    });

    it('tracks agent utilization in metrics', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();

      const result = await runner.runPhase(plan, plan.phases[1]);

      assert.ok(result.metrics.agentUtilization >= 0);
      assert.ok(result.metrics.agentUtilization <= 1);
    });

    it('estimates model cost based on agent tiers', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();

      const result = await runner.runPhase(plan, plan.phases[1]);

      assert.ok(result.metrics.modelCost >= 0);
    });

    it('assigns unique phaseId for each run', async () => {
      const runner = createPhaseRunner({ gateChecker: passingGate });
      const plan = makePlan();

      const r1 = await runner.runPhase(plan, plan.phases[1]);
      const r2 = await runner.runPhase(plan, plan.phases[1]);

      assert.notEqual(r1.phaseId, r2.phaseId);
    });
  });

  describe('Custom gate checkers', () => {
    it('gate checker receives phase context', async () => {
      let receivedPhase: PlannedPhase | undefined;
      let receivedPlanId: string | undefined;

      const spyGate: GateChecker = async (planId, phase) => {
        receivedPhase = phase;
        receivedPlanId = planId;
        return { passed: true };
      };

      const runner = createPhaseRunner({ gateChecker: spyGate });
      const plan = makePlan();
      await runner.runPhase(plan, plan.phases[1]);

      assert.ok(receivedPhase);
      assert.equal(receivedPhase!.type, 'refinement');
      assert.equal(receivedPlanId, 'plan-001');
    });

    it('conditional gate: passes for specification, fails for others', async () => {
      const conditionalGate: GateChecker = async (_planId, phase) => {
        if (phase.type === 'specification') return { passed: true };
        return { passed: false, reason: 'Not specification' };
      };

      const runner = createPhaseRunner({ gateChecker: conditionalGate });
      const plan = makePlan();

      const specResult = await runner.runPhase(plan, plan.phases[0]);
      assert.equal(specResult.status, 'completed');

      const refResult = await runner.runPhase(plan, plan.phases[1]);
      assert.equal(refResult.status, 'failed');
    });
  });
});
