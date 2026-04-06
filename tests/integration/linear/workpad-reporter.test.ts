/**
 * Tests for WorkpadReporter -- London School TDD with mocked EventBus + LinearClient.
 *
 * Covers: AC7 (workpad comment updates on phase transitions).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkpadComment,
  postOrUpdateWorkpad,
  createWorkpadReporter,
  syncPersistentWorkpadComment,
} from '../../../src/integration/linear/workpad-reporter';
import type { WorkpadState } from '../../../src/integration/linear/types';
import type { LinearClient } from '../../../src/integration/linear/linear-client';
import { createEventBus, createDomainEvent, type EventBus } from '../../../src/shared/event-bus';
import { createLogger } from '../../../src/shared/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLinearClient(): LinearClient & {
  commentCalls: Array<{ method: string; args: unknown[] }>;
} {
  const commentCalls: Array<{ method: string; args: unknown[] }> = [];
  return {
    commentCalls,
    fetchIssue: async () => ({ id: '', identifier: '', title: '', priority: 0, updatedAt: '', state: { id: '', name: '' }, labels: { nodes: [] }, assignee: null, creator: null, team: null, project: null }),
    fetchTeamStates: async () => [],
    fetchActiveIssues: async () => [],
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => [],
    fetchComments: async (issueId: string) => {
      commentCalls.push({ method: 'fetchComments', args: [issueId] });
      return [];
    },
    createComment: async (issueId: string, body: string) => {
      commentCalls.push({ method: 'createComment', args: [issueId, body] });
      return 'new-comment-id';
    },
    updateComment: async (commentId: string, body: string) => {
      commentCalls.push({ method: 'updateComment', args: [commentId, body] });
    },
    updateIssueState: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkpadReporter', () => {
  describe('buildWorkpadComment', () => {
    it('builds a structured markdown comment', () => {
      const state: WorkpadState = {
        planId: 'plan-1',
        linearIssueId: 'issue-1',
        currentPhase: 'specification',
        status: 'active',
        startedAt: new Date().toISOString(),
        elapsedMs: 65_000,
        agents: [
          { role: 'coder', type: 'sparc-coder', status: 'running', durationMs: 30_000 },
        ],
        phases: [
          { type: 'specification', status: 'active', summary: 'Running with 1 agent(s)' },
        ],
        findings: [],
      };

      const result = buildWorkpadComment(state);

      assert.ok(result.includes('## Agent Workpad'));
      assert.ok(result.includes('<!-- orch-agents-workpad -->'));
      assert.ok(result.includes('**Agent**: orch-agents (agent) is working on this'));
      assert.ok(result.includes('**Status**: specification (active)'));
      assert.ok(result.includes('**Elapsed**: 1m 5s'));
      assert.ok(result.includes('**Plan ID**: `plan-1`'));
      assert.ok(result.includes('| coder | sparc-coder | running | 30s |'));
      assert.ok(result.includes('- [ ] **specification**: Running with 1 agent(s)'));
    });

    it('includes findings when present', () => {
      const state: WorkpadState = {
        planId: 'plan-1',
        linearIssueId: 'issue-1',
        currentPhase: 'review',
        status: 'active',
        startedAt: new Date().toISOString(),
        elapsedMs: 120_000,
        agents: [],
        phases: [],
        findings: [
          { severity: 'warning', message: 'Potential memory leak' },
        ],
      };

      const result = buildWorkpadComment(state);

      assert.ok(result.includes('### Findings'));
      assert.ok(result.includes('- **warning**: Potential memory leak'));
    });

    it('marks completed phases with [x]', () => {
      const state: WorkpadState = {
        planId: 'plan-1',
        linearIssueId: 'issue-1',
        currentPhase: 'refinement',
        status: 'active',
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
        agents: [],
        phases: [
          { type: 'specification', status: 'completed', summary: 'Done in 5s' },
          { type: 'pseudocode', status: 'active' },
        ],
        findings: [],
      };

      const result = buildWorkpadComment(state);

      assert.ok(result.includes('- [x] **specification**: Done in 5s'));
      assert.ok(result.includes('- [ ] **pseudocode**: pending'));
    });
  });

  describe('postOrUpdateWorkpad', () => {
    it('creates a new comment when no workpad exists', async () => {
      const client = createMockLinearClient();
      await postOrUpdateWorkpad(client, 'issue-1', 'Workpad content');

      assert.equal(client.commentCalls.length, 2);
      assert.equal(client.commentCalls[0].method, 'fetchComments');
      assert.equal(client.commentCalls[1].method, 'createComment');
      assert.deepEqual(client.commentCalls[1].args, ['issue-1', 'Workpad content']);
    });

    it('updates existing comment when workpad marker found', async () => {
      const client = createMockLinearClient();
      // Override fetchComments to return existing workpad
      client.fetchComments = async () => [
        {
          id: 'existing-comment',
          body: 'old content\n<!-- orch-agents-workpad -->',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ];

      await postOrUpdateWorkpad(client, 'issue-1', 'Updated workpad');

      const updateCall = client.commentCalls.find((c) => c.method === 'updateComment');
      assert.ok(updateCall);
      assert.deepEqual(updateCall!.args, ['existing-comment', 'Updated workpad']);
    });

    it('reuses a known comment id without creating a new comment', async () => {
      const client = createMockLinearClient();

      const commentId = await syncPersistentWorkpadComment(
        client,
        'issue-1',
        'Updated workpad',
        'existing-comment',
      );

      assert.equal(commentId, 'existing-comment');
      assert.equal(client.commentCalls.length, 1);
      assert.equal(client.commentCalls[0].method, 'updateComment');
      assert.deepEqual(client.commentCalls[0].args, ['existing-comment', 'Updated workpad']);
    });
  });

  // AC7: WorkpadReporter subscribes and updates on phase transitions
  describe('createWorkpadReporter (AC7)', () => {
    let eventBus: EventBus;

    beforeEach(() => {
      eventBus = createEventBus();
    });

    afterEach(() => {
      eventBus.removeAllListeners();
    });

    it('creates a comment on PhaseStarted for a Linear issue', async () => {
      const client = createMockLinearClient();
      const reporter = createWorkpadReporter({
        eventBus,
        logger: createLogger({ level: 'fatal' }),
        linearClient: client,
      });

      reporter.start();

      // Simulate PlanCreated with a Linear intake event
      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: {
          id: 'plan-1',
          workItemId: 'work-1',
          methodology: 'sparc-full' as const,
          template: 'adhoc',
          topology: 'hierarchical' as const,
          swarmStrategy: 'specialized' as const,
          consensus: 'raft' as const,
          maxAgents: 3,
          phases: [],
          agentTeam: [],
          estimatedDuration: 0,
          estimatedCost: 0,
        },
        intakeEvent: {
          id: 'intake-1',
          timestamp: new Date().toISOString(),
          source: 'linear' as const,
          sourceMetadata: { linearIssueId: 'issue-lin-1' },
          intent: 'custom:linear-todo' as const,
          entities: {},
        },
      }));

      // Simulate PhaseStarted
      eventBus.publish(createDomainEvent('PhaseStarted', {
        planId: 'plan-1',
        phaseType: 'specification' as const,
        agents: ['coder'],
      }));

      // Give async handlers time to complete
      await new Promise((r) => setTimeout(r, 50));

      // Should have called fetchComments + createComment
      assert.ok(client.commentCalls.length >= 1);

      reporter.stop();
    });

    it('stops cleanly', () => {
      const client = createMockLinearClient();
      const reporter = createWorkpadReporter({
        eventBus,
        logger: createLogger({ level: 'fatal' }),
        linearClient: client,
      });

      reporter.start();
      reporter.stop();
      // No error
    });
  });

  // Phase 7E: Agent Activity Emission
  describe('Agent Activity Emission (Phase 7E)', () => {
    let eventBus: EventBus;

    beforeEach(() => {
      eventBus = createEventBus();
    });

    afterEach(() => {
      eventBus.removeAllListeners();
    });

    function setupReporterWithSession(opts?: { agentSessionId?: string; createAgentActivityFn?: (...args: unknown[]) => Promise<string> }) {
      const activityCalls: Array<{ sessionId: string; content: unknown; options?: unknown }> = [];
      const createAgentActivity = opts?.createAgentActivityFn ?? (async (sessionId: string, content: unknown, options?: unknown) => {
        activityCalls.push({ sessionId, content, options });
        return 'activity-id';
      });

      const client = {
        ...createMockLinearClient(),
        createAgentActivity,
      } as unknown as LinearClient;

      const reporter = createWorkpadReporter({
        eventBus,
        logger: createLogger({ level: 'fatal' }),
        linearClient: client,
        agentSessionId: opts?.agentSessionId ?? 'session-123',
      });

      return { reporter, activityCalls, client };
    }

    function publishPlanCreated() {
      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: {
          id: 'plan-1',
          workItemId: 'work-1',
          methodology: 'sparc-full' as const,
          template: 'adhoc',
          topology: 'hierarchical' as const,
          swarmStrategy: 'specialized' as const,
          consensus: 'raft' as const,
          maxAgents: 3,
          phases: [],
          agentTeam: [],
          estimatedDuration: 0,
          estimatedCost: 0,
        },
        intakeEvent: {
          id: 'intake-1',
          timestamp: new Date().toISOString(),
          source: 'linear' as const,
          sourceMetadata: { linearIssueId: 'issue-lin-1' },
          intent: 'custom:linear-todo' as const,
          entities: {},
        },
      }));
    }

    it('PhaseStarted emits ephemeral thought activity when agentSessionId present', async () => {
      const { reporter, activityCalls } = setupReporterWithSession();
      reporter.start();
      publishPlanCreated();

      eventBus.publish(createDomainEvent('PhaseStarted', {
        planId: 'plan-1',
        phaseType: 'specification',
        agents: ['coder', 'reviewer'],
      }));

      await new Promise((r) => setTimeout(r, 50));

      const call = activityCalls.find((c) =>
        (c.content as { type: string }).type === 'thought',
      );
      assert.ok(call, 'Expected a thought activity to be emitted');
      assert.equal(call!.sessionId, 'session-123');
      assert.deepEqual(call!.content, {
        type: 'thought',
        body: 'Starting specification phase with 2 agent(s)',
      });
      assert.deepEqual(call!.options, { ephemeral: true });

      reporter.stop();
    });

    it('AgentSpawned emits ephemeral action activity when agentSessionId present', async () => {
      const { reporter, activityCalls } = setupReporterWithSession();
      reporter.start();
      publishPlanCreated();

      eventBus.publish(createDomainEvent('AgentSpawned', {
        execId: 'exec-1',
        planId: 'plan-1',
        agentRole: 'coder',
        agentType: 'sparc-coder',
      }));

      await new Promise((r) => setTimeout(r, 50));

      const call = activityCalls.find((c) =>
        (c.content as { type: string }).type === 'action' &&
        (c.content as { action?: string }).action === 'Spawning agent',
      );
      assert.ok(call, 'Expected an action activity for AgentSpawned');
      assert.equal(call!.sessionId, 'session-123');
      assert.deepEqual(call!.content, {
        type: 'action',
        action: 'Spawning agent',
        parameter: 'sparc-coder (coder)',
      });
      assert.deepEqual(call!.options, { ephemeral: true });

      reporter.stop();
    });

    it('PhaseCompleted emits action activity with result when agentSessionId present', async () => {
      const { reporter, activityCalls } = setupReporterWithSession();
      reporter.start();
      publishPlanCreated();

      eventBus.publish(createDomainEvent('PhaseCompleted', {
        phaseResult: {
          planId: 'plan-1',
          phaseType: 'specification',
          status: 'completed',
          metrics: { duration: 4500 },
          outputs: [],
        },
      }));

      await new Promise((r) => setTimeout(r, 50));

      const call = activityCalls.find((c) =>
        (c.content as { type: string }).type === 'action' &&
        (c.content as { action?: string }).action === 'Phase completed',
      );
      assert.ok(call, 'Expected an action activity for PhaseCompleted');
      assert.equal(call!.sessionId, 'session-123');
      assert.deepEqual(call!.content, {
        type: 'action',
        action: 'Phase completed',
        parameter: 'specification',
        result: 'completed in 4500ms',
      });
      // Not ephemeral — no ephemeral flag
      assert.equal(call!.options, undefined);

      reporter.stop();
    });

    it('WorkCompleted emits response activity when agentSessionId present', async () => {
      const { reporter, activityCalls } = setupReporterWithSession();
      reporter.start();
      publishPlanCreated();

      // Need to create state first via PhaseStarted
      eventBus.publish(createDomainEvent('PhaseStarted', {
        planId: 'plan-1',
        phaseType: 'specification',
        agents: ['coder'],
      }));

      await new Promise((r) => setTimeout(r, 20));

      eventBus.publish(createDomainEvent('WorkCompleted', {
        planId: 'plan-1',
        totalDuration: 12000,
      }));

      await new Promise((r) => setTimeout(r, 50));

      const call = activityCalls.find((c) => {
        const content = c.content as { type: string; body?: string };
        return content.type === 'response' && content.body === 'Work completed. Duration: 12000ms';
      });
      assert.ok(call, 'Expected a response activity for WorkCompleted');
      assert.equal(call!.sessionId, 'session-123');

      reporter.stop();
    });

    it('WorkFailed emits error activity when agentSessionId present', async () => {
      const { reporter, activityCalls } = setupReporterWithSession();
      reporter.start();
      publishPlanCreated();

      // Create state via PhaseStarted
      eventBus.publish(createDomainEvent('PhaseStarted', {
        planId: 'plan-1',
        phaseType: 'specification',
        agents: ['coder'],
      }));

      await new Promise((r) => setTimeout(r, 20));

      eventBus.publish(createDomainEvent('WorkFailed', {
        workItemId: 'plan-1',
        failureReason: 'Agent timed out',
      }));

      await new Promise((r) => setTimeout(r, 50));

      const call = activityCalls.find((c) =>
        (c.content as { type: string }).type === 'error',
      );
      assert.ok(call, 'Expected an error activity for WorkFailed');
      assert.equal(call!.sessionId, 'session-123');
      assert.deepEqual(call!.content, {
        type: 'error',
        body: 'Work failed: Agent timed out',
      });

      reporter.stop();
    });

    it('no activity emission when agentSessionId is absent (backward compat)', async () => {
      const activityCalls: unknown[] = [];
      const client = {
        ...createMockLinearClient(),
        createAgentActivity: async (...args: unknown[]) => {
          activityCalls.push(args);
          return 'activity-id';
        },
      } as unknown as LinearClient;

      const reporter = createWorkpadReporter({
        eventBus,
        logger: createLogger({ level: 'fatal' }),
        linearClient: client,
        // No agentSessionId
      });

      reporter.start();

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: {
          id: 'plan-1',
          workItemId: 'work-1',
          methodology: 'sparc-full' as const,
          template: 'adhoc',
          topology: 'hierarchical' as const,
          swarmStrategy: 'specialized' as const,
          consensus: 'raft' as const,
          maxAgents: 3,
          phases: [],
          agentTeam: [],
          estimatedDuration: 0,
          estimatedCost: 0,
        },
        intakeEvent: {
          id: 'intake-1',
          timestamp: new Date().toISOString(),
          source: 'linear' as const,
          sourceMetadata: { linearIssueId: 'issue-lin-1' },
          intent: 'custom:linear-todo' as const,
          entities: {},
        },
      }));

      eventBus.publish(createDomainEvent('PhaseStarted', {
        planId: 'plan-1',
        phaseType: 'specification',
        agents: ['coder'],
      }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(activityCalls.length, 0, 'No activities should be emitted without agentSessionId');

      reporter.stop();
    });

    it('activity emission failure is swallowed (does not crash reporter)', async () => {
      let attemptCount = 0;
      const failingCreateActivity = async () => {
        attemptCount++;
        throw new Error('Linear API rate limited');
      };
      const client = createMockLinearClient();
      const combinedClient = {
        ...client,
        createAgentActivity: failingCreateActivity,
      } as unknown as LinearClient;

      const reporter2 = createWorkpadReporter({
        eventBus,
        logger: createLogger({ level: 'fatal' }),
        linearClient: combinedClient,
        agentSessionId: 'session-123',
      });

      reporter2.start();

      eventBus.publish(createDomainEvent('PlanCreated', {
        workflowPlan: {
          id: 'plan-1',
          workItemId: 'work-1',
          methodology: 'sparc-full' as const,
          template: 'adhoc',
          topology: 'hierarchical' as const,
          swarmStrategy: 'specialized' as const,
          consensus: 'raft' as const,
          maxAgents: 3,
          phases: [],
          agentTeam: [],
          estimatedDuration: 0,
          estimatedCost: 0,
        },
        intakeEvent: {
          id: 'intake-1',
          timestamp: new Date().toISOString(),
          source: 'linear' as const,
          sourceMetadata: { linearIssueId: 'issue-lin-1' },
          intent: 'custom:linear-todo' as const,
          entities: {},
        },
      }));

      eventBus.publish(createDomainEvent('PhaseStarted', {
        planId: 'plan-1',
        phaseType: 'specification',
        agents: ['coder'],
      }));

      await new Promise((r) => setTimeout(r, 50));

      // Failure is swallowed — emission was attempted but no crash propagated
      assert.ok(attemptCount >= 1, 'Activity emission should have been attempted');

      reporter2.stop();
    });
  });
});
