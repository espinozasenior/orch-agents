/**
 * Tests for the Execution Engine.
 *
 * As of Option C step 2 (PR A), the engine dispatches every IntakeCompleted
 * event through LocalAgentTask in coordinator mode. The legacy template branch
 * (template lookup, agent path resolution, multi-agent fan-out) has been
 * removed from the main-thread engine.
 *
 * The engine:
 * 1. Subscribes to IntakeCompleted
 * 2. Builds a coordinator-only WorkflowPlan
 * 3. Runs it via LocalAgentTask
 * 4. Publishes WorkCompleted / WorkFailed
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent, WorkflowPlan } from '../src/types';
import { createEventBus, createDomainEvent } from '../src/shared/event-bus';
import { createLogger } from '../src/shared/logger';
import {
  startExecutionEngine,
} from '../src/execution/orchestrator/execution-engine';
import type {
  CoordinatorDispatcher as LocalAgentTaskExecutor,
  ExecutionResult,
} from '../src/execution/coordinator-dispatcher';
import type { WorkflowConfig } from '../src/integration/linear/workflow-parser';
import type { LinearClient } from '../src/integration/linear/linear-client';
import type { SkillResolver, ResolvedSkill } from '../src/intake/skill-resolver';

// P20: stub resolver that returns a constant skill regardless of inputs.
function makeStubSkillResolver(body = 'STUB SKILL BODY'): SkillResolver {
  const skill: ResolvedSkill = {
    path: '/abs/SKILL.md',
    body,
    frontmatter: {
      name: 'stub', type: null, description: null, color: null,
      capabilities: [], version: null, contextFetchers: [],
      whenToUse: null, allowedTools: [],
    },
  };
  return {
    resolvePath: () => ({ relPath: '.claude/skills/stub/SKILL.md', ruleKey: 'stub' }),
    resolveByPath: () => skill,
    resolveSkillForEvent: () => skill,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'intake-001',
    timestamp: '2026-03-12T00:00:00Z',
    source: 'github',
    sourceMetadata: { template: 'github-ops', intent: 'review-pr', skillPath: '.claude/skills/stub/SKILL.md', ruleKey: 'stub' },
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
    tracker: { kind: 'linear', apiKey: '', team: 'test', activeTypes: ['unstarted', 'started'], terminalTypes: ['completed', 'canceled'], activeStates: [], terminalStates: [] },
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

function makeSuccessTask(): LocalAgentTaskExecutor & { lastPlan?: WorkflowPlan } {
  const wrapper: LocalAgentTaskExecutor & { lastPlan?: WorkflowPlan } = {
    async execute(plan): Promise<ExecutionResult> {
      wrapper.lastPlan = plan;
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
  return wrapper;
}

function makeFailTask(): LocalAgentTaskExecutor {
  return {
    async execute(): Promise<ExecutionResult> {
      return {
        status: 'failed',
        agentResults: [
          { agentRole: 'coordinator', agentType: 'coordinator', status: 'failed', findings: [], duration: 100 },
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
  describe('IntakeCompleted -> LocalAgentTask coordinator dispatch', () => {
    it('publishes WorkCompleted on successful execution', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const localAgentTask = makeSuccessTask();
      const unsub = startExecutionEngine({
        eventBus, logger,
        localAgentTask,
        workflowConfig: makeWorkflowConfig(),
        skillResolver: makeStubSkillResolver(),
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
      // Coordinator-only: exactly one agent dispatched, regardless of template
      assert.equal(workCompleted[0].phaseCount, 1);

      unsub();
      eventBus.removeAllListeners();
    });

    it('always builds a coordinator-only plan, ignoring template metadata', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const localAgentTask = makeSuccessTask();
      const unsub = startExecutionEngine({
        eventBus, logger,
        localAgentTask,
        workflowConfig: makeWorkflowConfig(),
        skillResolver: makeStubSkillResolver(),
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          // tdd-workflow used to fan out to coder + tester; now ignored.
          sourceMetadata: { template: 'tdd-workflow', skillPath: '.claude/skills/stub/SKILL.md', ruleKey: 'stub' },
        }),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.ok(localAgentTask.lastPlan, 'expected localAgentTask.execute to be called');
      assert.equal(localAgentTask.lastPlan!.methodology, 'coordinator');
      assert.equal(localAgentTask.lastPlan!.agentTeam.length, 1);
      assert.equal(localAgentTask.lastPlan!.agentTeam[0].role, 'coordinator');
      assert.equal(localAgentTask.lastPlan!.agentTeam[0].type, 'coordinator');
      // Template name still preserved on plan for observability.
      assert.equal(localAgentTask.lastPlan!.template, 'tdd-workflow');

      unsub();
      eventBus.removeAllListeners();
    });

    it('uses "coordinator" as plan template when intake provides no template metadata', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const localAgentTask = makeSuccessTask();
      const unsub = startExecutionEngine({
        eventBus, logger,
        localAgentTask,
        workflowConfig: makeWorkflowConfig(),
        skillResolver: makeStubSkillResolver(),
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({ sourceMetadata: { skillPath: '.claude/skills/stub/SKILL.md', ruleKey: 'stub' } }),
      }));

      await new Promise((r) => setTimeout(r, 100));

      assert.ok(localAgentTask.lastPlan);
      assert.equal(localAgentTask.lastPlan!.template, 'coordinator');
      assert.equal(localAgentTask.lastPlan!.methodology, 'coordinator');

      unsub();
      eventBus.removeAllListeners();
    });

    it('publishes WorkFailed when LocalAgentTask returns failed', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const unsub = startExecutionEngine({
        eventBus, logger,
        localAgentTask: makeFailTask(),
        workflowConfig: makeWorkflowConfig(),
        skillResolver: makeStubSkillResolver(),
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

    it('publishes WorkFailed when LocalAgentTask throws', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const throwingTask: LocalAgentTaskExecutor = {
        async execute() { throw new Error('Connection reset'); },
      };

      const unsub = startExecutionEngine({
        eventBus, logger,
        localAgentTask: throwingTask,
        workflowConfig: makeWorkflowConfig(),
        skillResolver: makeStubSkillResolver(),
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
        localAgentTask: makeSuccessTask(),
        workflowConfig: makeWorkflowConfig(),
        skillResolver: makeStubSkillResolver(),
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

    it('moves Linear work to In Progress and posts workpad when execution starts', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const linearClient = makeLinearClient();

      const unsub = startExecutionEngine({
        eventBus,
        logger,
        localAgentTask: makeSuccessTask(),
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
      const blockingTask: LocalAgentTaskExecutor = {
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
        localAgentTask: blockingTask,
        workflowConfig: makeWorkflowConfig(),
        skillResolver: makeStubSkillResolver(),
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

    it('does not invoke LocalAgentTask for Linear intake when Symphony mode is enabled', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      let executeCalls = 0;
      const trackingTask: LocalAgentTaskExecutor = {
        async execute(): Promise<ExecutionResult> {
          executeCalls += 1;
          return { status: 'completed', agentResults: [], totalDuration: 10 };
        },
      };

      const unsub = startExecutionEngine({
        eventBus,
        logger,
        localAgentTask: trackingTask,
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

  // -------------------------------------------------------------------------
  // P20: skill resolution + context fetching for github IntakeCompleted
  // -------------------------------------------------------------------------

  describe('P20 skill resolution', () => {
    it('composes skill body + trigger context into rawText', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      const localAgentTask = makeSuccessTask();
      const unsub = startExecutionEngine({
        eventBus, logger,
        localAgentTask,
        workflowConfig: makeWorkflowConfig(),
        skillResolver: makeStubSkillResolver('# GitHub Ops\n\nReview the PR.'),
      });

      const dispatched: Array<{ rawText?: string }> = [];
      const wrap = localAgentTask.execute.bind(localAgentTask);
      localAgentTask.execute = async (plan, intake) => {
        dispatched.push({ rawText: intake.rawText });
        return wrap(plan, intake);
      };

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent(),
      }));
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(dispatched.length, 1);
      assert.match(dispatched[0].rawText!, /# GitHub Ops/);
      assert.match(dispatched[0].rawText!, /## Trigger Context/);

      unsub();
      eventBus.removeAllListeners();
    });

    it('skips dispatch and warns when skillPath is missing', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      let executed = false;
      const localAgentTask: LocalAgentTaskExecutor = {
        async execute() {
          executed = true;
          return { status: 'completed', agentResults: [], totalDuration: 0 };
        },
      };
      const unsub = startExecutionEngine({
        eventBus, logger,
        localAgentTask,
        workflowConfig: makeWorkflowConfig(),
        skillResolver: makeStubSkillResolver(),
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent({
          sourceMetadata: { template: 'github-ops' },
        }),
      }));
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(executed, false);

      unsub();
      eventBus.removeAllListeners();
    });

    it('skips dispatch when skill file cannot be resolved', async () => {
      const eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });
      let executed = false;
      const localAgentTask: LocalAgentTaskExecutor = {
        async execute() {
          executed = true;
          return { status: 'completed', agentResults: [], totalDuration: 0 };
        },
      };
      const nullResolver: SkillResolver = {
        resolvePath: () => null,
        resolveByPath: () => null,
        resolveSkillForEvent: () => null,
      };
      const unsub = startExecutionEngine({
        eventBus, logger,
        localAgentTask,
        workflowConfig: makeWorkflowConfig(),
        skillResolver: nullResolver,
      });

      eventBus.publish(createDomainEvent('IntakeCompleted', {
        intakeEvent: makeIntakeEvent(),
      }));
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(executed, false);

      unsub();
      eventBus.removeAllListeners();
    });
  });
});
