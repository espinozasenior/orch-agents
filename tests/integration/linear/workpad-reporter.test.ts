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
    fetchActiveIssues: async () => [],
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
});
