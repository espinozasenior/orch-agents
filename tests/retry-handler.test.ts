/**
 * TDD: Tests for RetryHandler.
 *
 * RED phase: These tests define the contract for retry logic
 * that wraps the PhaseRunner, retrying failed non-skippable phases
 * up to a configurable maxRetries before propagating failure.
 *
 * The RetryHandler:
 * 1. Delegates to PhaseRunner.runPhase()
 * 2. On success or skip, returns immediately (no retry)
 * 3. On failure of non-skippable phase, retries up to maxRetries
 * 4. Publishes PhaseRetried event on each retry attempt
 * 5. Skippable phases are NOT retried (they skip via PhaseRunner)
 * 6. After maxRetries exhausted, returns the final failed result
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowPlan, PlannedPhase, PhaseResult } from '../src/types';
import { createEventBus, createDomainEvent } from '../src/shared/event-bus';
import type { PhaseRunner } from '../src/execution/phase-runner';
import {
  createRetryHandler,
  type RetryHandlerDeps,
} from '../src/execution/retry-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-retry-001',
    workItemId: 'work-retry-001',
    methodology: 'sparc-partial',
    template: 'github-ops',
    topology: 'hierarchical',
    swarmStrategy: 'specialized',
    consensus: 'raft',
    maxAgents: 4,
    phases: [
      { type: 'refinement', agents: ['coder', 'tester'], gate: 'tests-pass', skippable: false },
      { type: 'completion', agents: ['reviewer'], gate: 'review-approved', skippable: false },
    ],
    agentTeam: [
      { role: 'implementer', type: 'coder', tier: 3, required: true },
      { role: 'validator', type: 'tester', tier: 2, required: true },
      { role: 'reviewer', type: 'reviewer', tier: 2, required: false },
    ],
    estimatedDuration: 15,
    estimatedCost: 0.02,
    ...overrides,
  };
}

function makePhaseResult(
  plan: WorkflowPlan,
  phase: PlannedPhase,
  status: 'completed' | 'failed' | 'skipped',
): PhaseResult {
  return {
    phaseId: `phase-${Date.now()}`,
    planId: plan.id,
    phaseType: phase.type,
    status,
    artifacts: [],
    metrics: { duration: 10, agentUtilization: 0.5, modelCost: 0.003 },
  };
}

/** Creates a mock PhaseRunner that returns a fixed result. */
function mockPhaseRunner(
  resultFn: (plan: WorkflowPlan, phase: PlannedPhase) => Promise<PhaseResult>,
): PhaseRunner {
  return { runPhase: resultFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RetryHandler', () => {
  describe('createRetryHandler()', () => {
    it('returns a PhaseRunner-compatible object', () => {
      const eventBus = createEventBus();
      const inner = mockPhaseRunner(async (plan, phase) =>
        makePhaseResult(plan, phase, 'completed'),
      );

      const handler = createRetryHandler({ phaseRunner: inner, eventBus });

      assert.ok(handler);
      assert.equal(typeof handler.runPhase, 'function');
    });
  });

  describe('successful phase (no retry needed)', () => {
    it('passes through without retry when phase succeeds', async () => {
      const eventBus = createEventBus();
      let callCount = 0;
      const inner = mockPhaseRunner(async (plan, phase) => {
        callCount++;
        return makePhaseResult(plan, phase, 'completed');
      });

      const handler = createRetryHandler({ phaseRunner: inner, eventBus });
      const plan = makePlan();
      const phase = plan.phases[0];

      const result = await handler.runPhase(plan, phase);

      assert.equal(result.status, 'completed');
      assert.equal(callCount, 1, 'PhaseRunner should be called exactly once');
    });
  });

  describe('failed phase retries', () => {
    it('retries up to maxRetries (default 3) on failure', async () => {
      const eventBus = createEventBus();
      let callCount = 0;
      const inner = mockPhaseRunner(async (plan, phase) => {
        callCount++;
        return makePhaseResult(plan, phase, 'failed');
      });

      const handler = createRetryHandler({ phaseRunner: inner, eventBus });
      const plan = makePlan();
      const phase = plan.phases[0]; // non-skippable

      const result = await handler.runPhase(plan, phase);

      // 1 initial + 3 retries = 4 total calls
      assert.equal(callCount, 4, 'Should attempt 1 initial + 3 retries');
      assert.equal(result.status, 'failed');
    });

    it('succeeds on 2nd attempt after 1 failure', async () => {
      const eventBus = createEventBus();
      let callCount = 0;
      const inner = mockPhaseRunner(async (plan, phase) => {
        callCount++;
        if (callCount === 1) {
          return makePhaseResult(plan, phase, 'failed');
        }
        return makePhaseResult(plan, phase, 'completed');
      });

      const handler = createRetryHandler({ phaseRunner: inner, eventBus });
      const plan = makePlan();
      const phase = plan.phases[0];

      const result = await handler.runPhase(plan, phase);

      assert.equal(callCount, 2, 'Should call twice: 1 failure + 1 success');
      assert.equal(result.status, 'completed');
    });

    it('publishes PhaseRetried event on each retry', async () => {
      const eventBus = createEventBus();
      let callCount = 0;
      const inner = mockPhaseRunner(async (plan, phase) => {
        callCount++;
        return makePhaseResult(plan, phase, 'failed');
      });

      const retriedEvents: { retryCount: number; feedback: string }[] = [];
      eventBus.subscribe('PhaseRetried', (evt) => {
        retriedEvents.push({
          retryCount: evt.payload.retryCount,
          feedback: evt.payload.feedback,
        });
      });

      const handler = createRetryHandler({ phaseRunner: inner, eventBus });
      const plan = makePlan();
      const phase = plan.phases[0];

      await handler.runPhase(plan, phase);

      // 3 retries = 3 PhaseRetried events
      assert.equal(retriedEvents.length, 3, 'Should publish 3 PhaseRetried events');
      assert.equal(retriedEvents[0].retryCount, 1);
      assert.equal(retriedEvents[1].retryCount, 2);
      assert.equal(retriedEvents[2].retryCount, 3);
    });

    it('after max retries exhausted, failure propagates', async () => {
      const eventBus = createEventBus();
      const inner = mockPhaseRunner(async (plan, phase) =>
        makePhaseResult(plan, phase, 'failed'),
      );

      const handler = createRetryHandler({ phaseRunner: inner, eventBus });
      const plan = makePlan();
      const phase = plan.phases[0];

      const result = await handler.runPhase(plan, phase);

      assert.equal(result.status, 'failed', 'Should propagate failure after retries exhausted');
    });
  });

  describe('configurable maxRetries', () => {
    it('respects custom maxRetries value', async () => {
      const eventBus = createEventBus();
      let callCount = 0;
      const inner = mockPhaseRunner(async (plan, phase) => {
        callCount++;
        return makePhaseResult(plan, phase, 'failed');
      });

      const handler = createRetryHandler({
        phaseRunner: inner,
        eventBus,
        maxRetries: 5,
      });
      const plan = makePlan();
      const phase = plan.phases[0];

      await handler.runPhase(plan, phase);

      // 1 initial + 5 retries = 6
      assert.equal(callCount, 6, 'Should attempt 1 initial + 5 retries');
    });

    it('maxRetries of 0 means no retries', async () => {
      const eventBus = createEventBus();
      let callCount = 0;
      const inner = mockPhaseRunner(async (plan, phase) => {
        callCount++;
        return makePhaseResult(plan, phase, 'failed');
      });

      const handler = createRetryHandler({
        phaseRunner: inner,
        eventBus,
        maxRetries: 0,
      });
      const plan = makePlan();
      const phase = plan.phases[0];

      await handler.runPhase(plan, phase);

      assert.equal(callCount, 1, 'Should call only once with maxRetries=0');
    });
  });

  describe('skippable phases are NOT retried', () => {
    it('returns skipped result immediately without retry', async () => {
      const eventBus = createEventBus();
      let callCount = 0;
      const inner = mockPhaseRunner(async (plan, phase) => {
        callCount++;
        return makePhaseResult(plan, phase, 'skipped');
      });

      const retriedEvents: unknown[] = [];
      eventBus.subscribe('PhaseRetried', (evt) => {
        retriedEvents.push(evt);
      });

      const handler = createRetryHandler({ phaseRunner: inner, eventBus });
      const plan = makePlan({
        phases: [
          { type: 'specification', agents: ['architect'], gate: 'spec-approved', skippable: true },
        ],
      });
      const phase = plan.phases[0];

      const result = await handler.runPhase(plan, phase);

      assert.equal(result.status, 'skipped');
      assert.equal(callCount, 1, 'Should not retry skipped phases');
      assert.equal(retriedEvents.length, 0, 'No PhaseRetried events for skipped phases');
    });
  });

  describe('PhaseRetried event payload', () => {
    it('includes phaseId and feedback from the failed result', async () => {
      const eventBus = createEventBus();
      let callCount = 0;
      const inner = mockPhaseRunner(async (plan, phase) => {
        callCount++;
        if (callCount <= 1) {
          return makePhaseResult(plan, phase, 'failed');
        }
        return makePhaseResult(plan, phase, 'completed');
      });

      const retriedEvents: { phaseId: string; retryCount: number; feedback: string }[] = [];
      eventBus.subscribe('PhaseRetried', (evt) => {
        retriedEvents.push(evt.payload);
      });

      const handler = createRetryHandler({ phaseRunner: inner, eventBus });
      const plan = makePlan();
      const phase = plan.phases[0];

      await handler.runPhase(plan, phase);

      assert.equal(retriedEvents.length, 1);
      assert.ok(retriedEvents[0].phaseId, 'Should include phaseId');
      assert.equal(retriedEvents[0].retryCount, 1);
      assert.ok(
        retriedEvents[0].feedback.includes('refinement'),
        'Feedback should reference the phase type',
      );
    });
  });
});
