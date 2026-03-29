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
import type { LinearClient } from '../src/integration/linear/linear-client';

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
    agent: { maxConcurrentAgents: 8, maxRetryBackoffMs: 300000, maxTurns: 20 },
    polling: { intervalMs: 30000, enabled: false },
    stall: { timeoutMs: 300000 },
    agentRunner: { stallTimeoutMs: 300000, command: 'claude', turnTimeoutMs: 3600000 },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 60000 },
    promptTemplate: '',
  };
}

function makeLinearClient(): LinearClient & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    fetchIssue: async (issueId: string) => {
      calls.push({ method: 'fetchIssue', args: [issueId] });
      return {
        id: issueId,
        identifier: 'AUT-99',
        title: 'Linear task',
        priority: 1,
        updatedAt: new Date().toISOString(),
        state: { id: 'state-todo', name: 'Todo', type: 'unstarted' },
        labels: { nodes: [] },
        assignee: null,
        creator: null,
        team: { id: 'team-1', key: 'AUT', name: 'Automata' },
        project: null,
      };
    },
    fetchTeamStates: async (teamId: string) => {
      calls.push({ method: 'fetchTeamStates', args: [teamId] });
      return [
        { id: 'state-todo', name: 'Todo', type: 'unstarted' },
        { id: 'state-progress', name: 'In Progress', type: 'started' },
      ];
    },
    fetchActiveIssues: async () => [],
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => [],
    fetchComments: async (issueId: string) => {
      calls.push({ method: 'fetchComments', args: [issueId] });
      return [];
    },
    createComment: async (issueId: string, body: string) => {
      calls.push({ method: 'createComment', args: [issueId, body] });
      return 'comment-1';
    },
    updateComment: async () => {},
    updateIssueState: async (issueId: string, stateId: string) => {
      calls.push({ method: 'updateIssueState', args: [issueId, stateId] });
    },
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

    it('moves Linear work to In Progress and comments when execution starts', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const linearClient = makeLinearClient();

      const unsub = startExecutionEngine({
        eventBus,
        logger,
        simpleExecutor: makeSuccessExecutor(),
        workflowConfig: makeWorkflowConfig(),
        linearClient,
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          source: 'linear',
          sourceMetadata: {
            template: 'quick-fix',
            linearIssueId: 'issue-linear-1',
          },
        }),
      }));

      await new Promise((r) => setTimeout(r, 100));

      const methods = linearClient.calls.map((call) => call.method);
      assert.ok(methods.includes('fetchIssue'));
      assert.ok(methods.includes('fetchTeamStates'));
      assert.ok(methods.includes('updateIssueState'));
      assert.ok(methods.includes('fetchComments'));
      assert.ok(methods.includes('createComment'));

      const updateCall = linearClient.calls.find((call) => call.method === 'updateIssueState');
      assert.deepEqual(updateCall?.args, ['issue-linear-1', 'state-progress']);

      const commentCall = linearClient.calls.find((call) => call.method === 'createComment');
      assert.equal(commentCall?.args[0], 'issue-linear-1');
      assert.ok(String(commentCall?.args[1]).includes('is working on this'));

      unsub();
      eventBus.removeAllListeners();
    });

    it('deduplicates concurrent Linear deliveries for the same issue', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      let executeCalls = 0;
      let releaseExecution: (() => void) | undefined;
      const blockingExecutor: SimpleExecutor = {
        async execute(): Promise<ExecutionResult> {
          executeCalls += 1;
          await new Promise<void>((resolve) => {
            releaseExecution = resolve;
          });
          return { status: 'completed', agentResults: [], totalDuration: 10 };
        },
      };

      const unsub = startExecutionEngine({
        eventBus,
        logger,
        simpleExecutor: blockingExecutor,
        workflowConfig: makeWorkflowConfig(),
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          id: 'intake-linear-1',
          source: 'linear',
          sourceMetadata: {
            template: 'quick-fix',
            linearIssueId: 'issue-linear-stable-1',
          },
        }),
      }));

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          id: 'intake-linear-2',
          source: 'linear',
          sourceMetadata: {
            template: 'quick-fix',
            linearIssueId: 'issue-linear-stable-1',
          },
        }),
      }));

      await new Promise((r) => setTimeout(r, 50));
      assert.equal(executeCalls, 1);

      releaseExecution?.();
      await new Promise((r) => setTimeout(r, 50));

      unsub();
      eventBus.removeAllListeners();
    });

    it('does not invoke the generic executor for Linear intake when Symphony mode is enabled', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      let executeCalls = 0;
      const trackingExecutor: SimpleExecutor = {
        async execute(): Promise<ExecutionResult> {
          executeCalls += 1;
          return { status: 'completed', agentResults: [], totalDuration: 10 };
        },
      };

      const unsub = startExecutionEngine({
        eventBus,
        logger,
        simpleExecutor: trackingExecutor,
        workflowConfig: makeWorkflowConfig(),
        linearExecutionMode: 'symphony',
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          id: 'linear-intake-skip-1',
          source: 'linear',
          sourceMetadata: {
            template: 'quick-fix',
            linearIssueId: 'issue-linear-skip-1',
          },
        }),
      }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(executeCalls, 0);

      unsub();
      eventBus.removeAllListeners();
    });
  });
});
