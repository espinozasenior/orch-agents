/**
 * Tests for the Execution Engine.
 *
 * The execution engine:
 * 1. Subscribes to IntakeCompleted
 * 2. Resolves template from WorkflowConfig
 * 3. Runs agents via SimpleExecutor
 * 4. Publishes WorkCompleted / WorkFailed
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent } from '../src/types';
import { createEventBus, createDomainEvent } from '../src/shared/event-bus';
import { createLogger } from '../src/shared/logger';
import {
  startExecutionEngine,
} from '../src/execution/orchestrator/execution-engine';
import type { SimpleExecutor, ExecutionResult } from '../src/execution/simple-executor';
import type { WorkflowConfig } from '../src/integration/linear/workflow-parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'intake-001',
    timestamp: '2026-03-12T00:00:00Z',
    source: 'github',
    sourceMetadata: { template: 'github-ops' },
    intent: 'review-pr',
    entities: { repo: 'test/repo', branch: 'main' },
    rawText: 'Test task',
    ...overrides,
  };
}

function makeWorkflowConfig(): WorkflowConfig {
  return {
    templates: {
      'github-ops': ['.claude/agents/core/reviewer.md'],
      'tdd-workflow': ['.claude/agents/core/coder.md', '.claude/agents/core/tester.md'],
      'quick-fix': ['.claude/agents/core/coder.md'],
    },
    tracker: { kind: 'linear', apiKey: '', team: 'test', activeStates: ['Todo'], terminalStates: ['Done'] },
    agents: { maxConcurrent: 8, routing: { bug: 'tdd-workflow' }, defaultTemplate: 'quick-fix' },
    polling: { intervalMs: 30000, enabled: false },
    stall: { timeoutMs: 300000 },
    promptTemplate: '',
  };
}

function makeSuccessExecutor(): SimpleExecutor {
  return {
    async execute(plan): Promise<ExecutionResult> {
      return {
        status: 'completed',
        agentResults: plan.agentTeam.map((a) => ({
          agentRole: a.role,
          agentType: a.type,
          status: 'completed' as const,
          findings: [],
          duration: 100,
        })),
        totalDuration: 150,
      };
    },
  };
}

function makeFailExecutor(): SimpleExecutor {
  return {
    async execute(): Promise<ExecutionResult> {
      return {
        status: 'failed',
        agentResults: [
          { agentRole: 'coder', agentType: 'coder', status: 'failed', findings: [], duration: 100 },
        ],
        totalDuration: 100,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Execution Engine', () => {
  describe('IntakeCompleted -> SimpleExecutor execution', () => {
    it('publishes WorkCompleted on successful execution', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const unsub = startExecutionEngine({
        eventBus, logger,
        simpleExecutor: makeSuccessExecutor(),
        workflowConfig: makeWorkflowConfig(),
      });

      const workCompleted: { workItemId: string; planId: string; phaseCount: number }[] = [];
      eventBus.subscribe('WorkCompleted', (evt) => {
        workCompleted.push(evt.payload);
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent(),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(workCompleted.length, 1);
      assert.equal(workCompleted[0].workItemId, 'intake-001');
      assert.ok(workCompleted[0].planId);
      // github-ops template has 1 agent: reviewer
      assert.equal(workCompleted[0].phaseCount, 1);

      unsub();
      eventBus.removeAllListeners();
    });

    it('resolves correct agents from template', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      let executedAgents: string[] = [];
      const trackingExecutor: SimpleExecutor = {
        async execute(plan): Promise<ExecutionResult> {
          executedAgents = plan.agentTeam.map((a) => a.type);
          return { status: 'completed', agentResults: [], totalDuration: 10 };
        },
      };

      const unsub = startExecutionEngine({
        eventBus, logger,
        simpleExecutor: trackingExecutor,
        workflowConfig: makeWorkflowConfig(),
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          sourceMetadata: { template: 'tdd-workflow' },
        }),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.deepEqual(executedAgents, ['.claude/agents/core/coder.md', '.claude/agents/core/tester.md']);

      unsub();
      eventBus.removeAllListeners();
    });

    it('falls back to default template when template not found', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      let executedAgents: string[] = [];
      const trackingExecutor: SimpleExecutor = {
        async execute(plan): Promise<ExecutionResult> {
          executedAgents = plan.agentTeam.map((a) => a.type);
          return { status: 'completed', agentResults: [], totalDuration: 10 };
        },
      };

      const unsub = startExecutionEngine({
        eventBus, logger,
        simpleExecutor: trackingExecutor,
        workflowConfig: makeWorkflowConfig(),
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          sourceMetadata: { template: 'nonexistent-template' },
        }),
      }));

      await new Promise((r) => setTimeout(r, 100));

      // Falls back to default 'quick-fix' -> ['.claude/agents/core/coder.md']
      assert.deepEqual(executedAgents, ['.claude/agents/core/coder.md']);

      unsub();
      eventBus.removeAllListeners();
    });

    it('publishes WorkFailed when all agents fail', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const unsub = startExecutionEngine({
        eventBus, logger,
        simpleExecutor: makeFailExecutor(),
        workflowConfig: makeWorkflowConfig(),
      });

      const failures: { workItemId: string; failureReason: string }[] = [];
      eventBus.subscribe('WorkFailed', (evt) => {
        failures.push(evt.payload);
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent(),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(failures.length, 1);
      assert.equal(failures[0].workItemId, 'intake-001');

      unsub();
      eventBus.removeAllListeners();
    });

    it('publishes WorkFailed when executor throws', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const throwingExecutor: SimpleExecutor = {
        async execute() { throw new Error('Connection reset'); },
      };

      const unsub = startExecutionEngine({
        eventBus, logger,
        simpleExecutor: throwingExecutor,
        workflowConfig: makeWorkflowConfig(),
      });

      const failures: { workItemId: string; failureReason: string }[] = [];
      eventBus.subscribe('WorkFailed', (evt) => {
        failures.push(evt.payload);
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent(),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(failures.length, 1);
      assert.ok(failures[0].failureReason.includes('Connection reset'));

      unsub();
      eventBus.removeAllListeners();
    });

    it('preserves correlation ID', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const unsub = startExecutionEngine({
        eventBus, logger,
        simpleExecutor: makeSuccessExecutor(),
        workflowConfig: makeWorkflowConfig(),
      });

      const correlationIds: string[] = [];
      eventBus.subscribe('WorkCompleted', (evt) => {
        correlationIds.push(evt.correlationId);
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent(),
      }, 'exec-correlation-001'));

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(correlationIds.length, 1);
      assert.equal(correlationIds[0], 'exec-correlation-001');

      unsub();
      eventBus.removeAllListeners();
    });
  });
});
