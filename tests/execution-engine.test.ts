/**
 * TDD: Tests for the Execution Engine.
 *
 * RED phase: These tests define the contract for orchestrating
 * SPARC phase execution in response to PlanCreated events.
 *
 * The execution engine:
 * 1. Subscribes to PlanCreated
 * 2. Runs phases sequentially via PhaseRunner
 * 3. Publishes PhaseStarted / PhaseCompleted for each phase
 * 4. Tracks overall work item state
 * 5. Publishes WorkFailed on unrecoverable errors
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowPlan, PhaseResult, SPARCPhase } from '../src/types';
import { createEventBus, createDomainEvent } from '../src/shared/event-bus';
import { createLogger } from '../src/shared/logger';
import {
  startExecutionEngine,
  type ExecutionEngineDeps,
} from '../src/execution/execution-engine';
import type { PhaseRunner, GateChecker } from '../src/execution/phase-runner';
import { createPhaseRunner } from '../src/execution/phase-runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    id: 'plan-exec-001',
    workItemId: 'work-exec-001',
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

const passingGate: GateChecker = async () => ({ passed: true });
const failingGate: GateChecker = async () => ({ passed: false, reason: 'Gate failed' });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Execution Engine', () => {
  describe('PlanCreated → phase execution', () => {
    it('executes all phases and publishes PhaseCompleted for each', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });

      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const phaseStarted: { phaseType: SPARCPhase }[] = [];
      const phaseCompleted: PhaseResult[] = [];

      eventBus.subscribe('PhaseStarted', (evt) => {
        phaseStarted.push({ phaseType: evt.payload.phaseType });
      });
      eventBus.subscribe('PhaseCompleted', (evt) => {
        phaseCompleted.push(evt.payload.phaseResult);
      });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(phaseStarted.length, 2, 'Should start 2 phases');
      assert.equal(phaseCompleted.length, 2, 'Should complete 2 phases');
      assert.equal(phaseStarted[0].phaseType, 'refinement');
      assert.equal(phaseStarted[1].phaseType, 'completion');
      assert.equal(phaseCompleted[0].status, 'completed');
      assert.equal(phaseCompleted[1].status, 'completed');

      unsub();
      eventBus.removeAllListeners();
    });

    it('phases execute in order', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });

      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const order: string[] = [];
      eventBus.subscribe('PhaseStarted', (evt) => {
        order.push(`start:${evt.payload.phaseType}`);
      });
      eventBus.subscribe('PhaseCompleted', (evt) => {
        order.push(`end:${evt.payload.phaseResult.phaseType}`);
      });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.deepEqual(order, [
        'start:refinement',
        'end:refinement',
        'start:completion',
        'end:completion',
      ]);

      unsub();
      eventBus.removeAllListeners();
    });

    it('preserves correlation ID through phase events', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });

      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const correlationIds: string[] = [];
      eventBus.subscribe('PhaseStarted', (evt) => {
        correlationIds.push(evt.correlationId);
      });
      eventBus.subscribe('PhaseCompleted', (evt) => {
        correlationIds.push(evt.correlationId);
      });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }, 'exec-correlation-001'));

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(correlationIds.length, 4);
      for (const cid of correlationIds) {
        assert.equal(cid, 'exec-correlation-001');
      }

      unsub();
      eventBus.removeAllListeners();
    });
  });

  describe('Phase failure handling', () => {
    it('publishes WorkFailed when non-skippable phase fails', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const phaseRunner = createPhaseRunner({ gateChecker: failingGate });

      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const failures: { workItemId: string; failureReason: string }[] = [];
      eventBus.subscribe('WorkFailed', (evt) => {
        failures.push(evt.payload);
      });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(failures.length, 1);
      assert.equal(failures[0].workItemId, 'work-exec-001');
      assert.ok(failures[0].failureReason.includes('refinement'));

      unsub();
      eventBus.removeAllListeners();
    });

    it('stops execution after first non-skippable failure', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const phaseRunner = createPhaseRunner({ gateChecker: failingGate });

      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const completed: PhaseResult[] = [];
      eventBus.subscribe('PhaseCompleted', (evt) => {
        completed.push(evt.payload.phaseResult);
      });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }));

      await new Promise((r) => setTimeout(r, 100));

      // First phase fails, second phase never starts
      assert.equal(completed.length, 1);
      assert.equal(completed[0].status, 'failed');

      unsub();
      eventBus.removeAllListeners();
    });

    it('skips skippable phases and continues', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      // Gate that fails only specification
      const selectiveGate: GateChecker = async (_planId, phase) => {
        if (phase.type === 'specification') return { passed: false, reason: 'spec failed' };
        return { passed: true };
      };
      const phaseRunner = createPhaseRunner({ gateChecker: selectiveGate });
      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const completed: PhaseResult[] = [];
      eventBus.subscribe('PhaseCompleted', (evt) => {
        completed.push(evt.payload.phaseResult);
      });

      const plan = makePlan({
        phases: [
          { type: 'specification', agents: ['architect'], gate: 'spec-approved', skippable: true },
          { type: 'refinement', agents: ['coder'], gate: 'tests-pass', skippable: false },
          { type: 'completion', agents: ['reviewer'], gate: 'review-approved', skippable: false },
        ],
      });

      eventBus.publish(createDomainEvent('PlanCreated', { workflowPlan: plan }));

      await new Promise((r) => setTimeout(r, 100));

      // All 3 phases complete: spec=skipped, refinement=completed, completion=completed
      assert.equal(completed.length, 3);
      assert.equal(completed[0].status, 'skipped');
      assert.equal(completed[0].phaseType, 'specification');
      assert.equal(completed[1].status, 'completed');
      assert.equal(completed[2].status, 'completed');

      unsub();
      eventBus.removeAllListeners();
    });
  });

  describe('Full SPARC execution', () => {
    it('executes all 5 SPARC phases for feature-build', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });
      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const completed: PhaseResult[] = [];
      eventBus.subscribe('PhaseCompleted', (evt) => {
        completed.push(evt.payload.phaseResult);
      });

      const plan = makePlan({
        id: 'plan-full-sparc',
        methodology: 'sparc-full',
        template: 'feature-build',
        phases: [
          { type: 'specification', agents: ['architect'], gate: 'spec-approved', skippable: false },
          { type: 'pseudocode', agents: ['architect'], gate: 'pseudo-reviewed', skippable: false },
          { type: 'architecture', agents: ['architect'], gate: 'arch-approved', skippable: false },
          { type: 'refinement', agents: ['coder', 'tester'], gate: 'tests-pass', skippable: false },
          { type: 'completion', agents: ['reviewer'], gate: 'review-approved', skippable: false },
        ],
      });

      eventBus.publish(createDomainEvent('PlanCreated', { workflowPlan: plan }));

      await new Promise((r) => setTimeout(r, 150));

      assert.equal(completed.length, 5);
      const phaseTypes = completed.map((c) => c.phaseType);
      assert.deepEqual(phaseTypes, [
        'specification', 'pseudocode', 'architecture', 'refinement', 'completion',
      ]);
      for (const c of completed) {
        assert.equal(c.status, 'completed');
        assert.equal(c.planId, 'plan-full-sparc');
      }

      unsub();
      eventBus.removeAllListeners();
    });
  });

  describe('Concurrent plan handling', () => {
    it('handles multiple PlanCreated events', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });
      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const planIds = new Set<string>();
      eventBus.subscribe('PhaseCompleted', (evt) => {
        planIds.add(evt.payload.phaseResult.planId);
      });

      // Fire two plans
      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan({ id: 'plan-A', workItemId: 'work-A' }),
      }));
      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan({ id: 'plan-B', workItemId: 'work-B' }),
      }));

      await new Promise((r) => setTimeout(r, 200));

      assert.ok(planIds.has('plan-A'));
      assert.ok(planIds.has('plan-B'));

      unsub();
      eventBus.removeAllListeners();
    });

    it('ignores duplicate PlanCreated with same plan ID', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });
      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const completedCount: number[] = [];
      eventBus.subscribe('PhaseCompleted', () => {
        completedCount.push(1);
      });

      const failures: string[] = [];
      eventBus.subscribe('WorkFailed', (evt) => {
        failures.push(evt.payload.failureReason);
      });

      const plan = makePlan({ id: 'dup-plan-001' });

      // Fire the same plan twice
      eventBus.publish(createDomainEvent('PlanCreated', { workflowPlan: plan }));
      eventBus.publish(createDomainEvent('PlanCreated', { workflowPlan: plan }));

      await new Promise((r) => setTimeout(r, 200));

      // Should only execute once — 2 phases from the single execution
      assert.equal(completedCount.length, 2);
      // No WorkFailed from "already tracked" error
      assert.equal(failures.length, 0);

      unsub();
      eventBus.removeAllListeners();
    });
  });

  describe('correlationId in log lines', () => {
    it('includes correlationId in "Executing plan" log', async () => {
      const eventBus = createEventBus();
      const logMessages: { level: string; msg: string; ctx?: Record<string, unknown> }[] = [];
      const spyLogger = {
        trace: () => {},
        debug: (msg: string, ctx?: unknown) => logMessages.push({ level: 'debug', msg, ctx: ctx as Record<string, unknown> }),
        info: (msg: string, ctx?: unknown) => logMessages.push({ level: 'info', msg, ctx: ctx as Record<string, unknown> }),
        warn: (msg: string, ctx?: unknown) => logMessages.push({ level: 'warn', msg, ctx: ctx as Record<string, unknown> }),
        error: (msg: string, ctx?: unknown) => logMessages.push({ level: 'error', msg, ctx: ctx as Record<string, unknown> }),
        fatal: () => {},
        child: () => spyLogger,
      };

      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });
      const unsub = startExecutionEngine({ eventBus, logger: spyLogger as ReturnType<typeof createLogger>, phaseRunner });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }, 'corr-id-abc'));

      await new Promise((r) => setTimeout(r, 100));

      const execLog = logMessages.find((l) => l.msg === 'Executing plan');
      assert.ok(execLog, 'Should log "Executing plan"');
      assert.equal(execLog!.ctx?.correlationId, 'corr-id-abc', 'Should include correlationId');

      unsub();
      eventBus.removeAllListeners();
    });

    it('includes correlationId in "Phase started" log', async () => {
      const eventBus = createEventBus();
      const logMessages: { level: string; msg: string; ctx?: Record<string, unknown> }[] = [];
      const spyLogger = {
        trace: () => {},
        debug: (msg: string, ctx?: unknown) => logMessages.push({ level: 'debug', msg, ctx: ctx as Record<string, unknown> }),
        info: (msg: string, ctx?: unknown) => logMessages.push({ level: 'info', msg, ctx: ctx as Record<string, unknown> }),
        warn: (msg: string, ctx?: unknown) => logMessages.push({ level: 'warn', msg, ctx: ctx as Record<string, unknown> }),
        error: (msg: string, ctx?: unknown) => logMessages.push({ level: 'error', msg, ctx: ctx as Record<string, unknown> }),
        fatal: () => {},
        child: () => spyLogger,
      };

      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });
      const unsub = startExecutionEngine({ eventBus, logger: spyLogger as ReturnType<typeof createLogger>, phaseRunner });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }, 'corr-id-def'));

      await new Promise((r) => setTimeout(r, 100));

      const phaseStartLogs = logMessages.filter((l) => l.msg === 'Phase started');
      assert.ok(phaseStartLogs.length > 0, 'Should log "Phase started"');
      assert.equal(phaseStartLogs[0].ctx?.correlationId, 'corr-id-def', 'Should include correlationId');

      unsub();
      eventBus.removeAllListeners();
    });

    it('includes correlationId in "Phase completed" log', async () => {
      const eventBus = createEventBus();
      const logMessages: { level: string; msg: string; ctx?: Record<string, unknown> }[] = [];
      const spyLogger = {
        trace: () => {},
        debug: (msg: string, ctx?: unknown) => logMessages.push({ level: 'debug', msg, ctx: ctx as Record<string, unknown> }),
        info: (msg: string, ctx?: unknown) => logMessages.push({ level: 'info', msg, ctx: ctx as Record<string, unknown> }),
        warn: (msg: string, ctx?: unknown) => logMessages.push({ level: 'warn', msg, ctx: ctx as Record<string, unknown> }),
        error: (msg: string, ctx?: unknown) => logMessages.push({ level: 'error', msg, ctx: ctx as Record<string, unknown> }),
        fatal: () => {},
        child: () => spyLogger,
      };

      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });
      const unsub = startExecutionEngine({ eventBus, logger: spyLogger as ReturnType<typeof createLogger>, phaseRunner });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }, 'corr-id-ghi'));

      await new Promise((r) => setTimeout(r, 100));

      const phaseCompleteLogs = logMessages.filter((l) => l.msg === 'Phase completed');
      assert.ok(phaseCompleteLogs.length > 0, 'Should log "Phase completed"');
      assert.equal(phaseCompleteLogs[0].ctx?.correlationId, 'corr-id-ghi', 'Should include correlationId');

      unsub();
      eventBus.removeAllListeners();
    });

    it('includes correlationId in "Plan execution completed" log', async () => {
      const eventBus = createEventBus();
      const logMessages: { level: string; msg: string; ctx?: Record<string, unknown> }[] = [];
      const spyLogger = {
        trace: () => {},
        debug: (msg: string, ctx?: unknown) => logMessages.push({ level: 'debug', msg, ctx: ctx as Record<string, unknown> }),
        info: (msg: string, ctx?: unknown) => logMessages.push({ level: 'info', msg, ctx: ctx as Record<string, unknown> }),
        warn: (msg: string, ctx?: unknown) => logMessages.push({ level: 'warn', msg, ctx: ctx as Record<string, unknown> }),
        error: (msg: string, ctx?: unknown) => logMessages.push({ level: 'error', msg, ctx: ctx as Record<string, unknown> }),
        fatal: () => {},
        child: () => spyLogger,
      };

      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });
      const unsub = startExecutionEngine({ eventBus, logger: spyLogger as ReturnType<typeof createLogger>, phaseRunner });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }, 'corr-id-jkl'));

      await new Promise((r) => setTimeout(r, 100));

      const completedLog = logMessages.find((l) => l.msg === 'Plan execution completed');
      assert.ok(completedLog, 'Should log "Plan execution completed"');
      assert.equal(completedLog!.ctx?.correlationId, 'corr-id-jkl', 'Should include correlationId');

      unsub();
      eventBus.removeAllListeners();
    });
  });

  describe('WorkCompleted event', () => {
    it('publishes WorkCompleted on successful execution', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const phaseRunner = createPhaseRunner({ gateChecker: passingGate });
      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const workCompleted: { workItemId: string; planId: string; phaseCount: number }[] = [];
      eventBus.subscribe('WorkCompleted', (evt) => {
        workCompleted.push(evt.payload);
      });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(workCompleted.length, 1);
      assert.equal(workCompleted[0].workItemId, 'work-exec-001');
      assert.equal(workCompleted[0].planId, 'plan-exec-001');
      assert.equal(workCompleted[0].phaseCount, 2);

      unsub();
      eventBus.removeAllListeners();
    });

    it('does NOT publish WorkCompleted on failure', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const phaseRunner = createPhaseRunner({ gateChecker: failingGate });
      const unsub = startExecutionEngine({ eventBus, logger, phaseRunner });

      const workCompleted: unknown[] = [];
      eventBus.subscribe('WorkCompleted', (evt) => {
        workCompleted.push(evt);
      });

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: makePlan(),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(workCompleted.length, 0);

      unsub();
      eventBus.removeAllListeners();
    });
  });
});
