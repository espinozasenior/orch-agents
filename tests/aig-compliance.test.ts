/**
 * AIG (Agent Interaction Guidelines) compliance tests.
 *
 * Validates: stop command detection, instant feedback, agent identity badge,
 * and that normal comments are not misinterpreted as stop commands.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { webhookRouter, type WebhookRouterDeps } from '../src/webhook-gateway/webhook-router';
import { createEventBuffer, type EventBuffer } from '../src/webhook-gateway/event-buffer';
import { loadConfig } from '../src/shared/config';
import { createLogger } from '../src/shared/logger';
import { createEventBus, createDomainEvent, type EventBus } from '../src/shared/event-bus';
import { setBotUserId } from '../src/intake/github-workflow-normalizer';
import type { WorkflowConfig } from '../src/integration/linear/workflow-parser';
import type { WorkCancelledEvent, IntakeCompletedEvent } from '../src/shared/event-types';
import { startExecutionEngine } from '../src/execution/orchestrator/execution-engine';
import type { SimpleExecutor, ExecutionResult } from '../src/execution/simple-executor';
import type { IntakeEvent } from '../src/types';
import { formatAgentComment, getBotMarker } from '../src/shared/agent-identity';
import {
  linearWebhookHandler,
  type LinearWebhookHandlerDeps,
} from '../src/integration/linear/linear-webhook-handler';
import {
  setWorkflowConfig,
  resetWorkflowConfig,
  setLinearBotUserId,
} from '../src/integration/linear/linear-normalizer';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'aig-test-secret';
const LINEAR_SECRET = 'aig-linear-secret';

function computeSignature(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function computeLinearSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function makeTestWorkflowConfig(): WorkflowConfig {
  return {
    templates: {
      'github-ops': ['.claude/agents/core/reviewer.md'],
      'quick-fix': ['.claude/agents/core/coder.md'],
    },
    github: {
      events: {
        'issue_comment.mentions_bot': 'quick-fix',
      },
    },
    tracker: { kind: 'linear', apiKey: '', team: 'test', activeTypes: ['unstarted', 'started'], terminalTypes: ['completed', 'canceled'], activeStates: [], terminalStates: [] },
    agents: { maxConcurrent: 8, routing: {}, defaultTemplate: 'quick-fix' },
    polling: { intervalMs: 30000, enabled: false },
    stall: { timeoutMs: 300000 },
    promptTemplate: '',
  };
}

// ---------------------------------------------------------------------------
// GitHub stop command tests
// ---------------------------------------------------------------------------

describe('AIG Compliance', () => {
  let server: FastifyInstance;
  let eventBus: EventBus;
  let buffer: EventBuffer;
  let deliveryCounter: number;

  function nextDeliveryId(): string {
    deliveryCounter += 1;
    return `aig-delivery-${deliveryCounter}`;
  }

  beforeEach(async () => {
    deliveryCounter = 0;
    setBotUserId(0);

    const config = loadConfig({
      PORT: '3997',
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      WEBHOOK_SECRET: TEST_SECRET,
    });
    const logger = createLogger({ level: 'fatal' });
    eventBus = createEventBus();
    buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });

    server = Fastify({ logger: false });
    await server.register(webhookRouter, {
      config,
      logger,
      eventBus,
      eventBuffer: buffer,
      workflowConfig: makeTestWorkflowConfig(),
    } satisfies WebhookRouterDeps);
    await server.ready();
  });

  afterEach(async () => {
    buffer.dispose();
    eventBus.removeAllListeners();
    await server.close();
  });

  describe('Stop command detection (GitHub)', () => {
    it('should detect "stop" in issue comment and publish WorkCancelled', async () => {
      const cancelEvents: WorkCancelledEvent[] = [];
      eventBus.subscribe('WorkCancelled', (event) => {
        cancelEvents.push(event);
      });

      const payload = {
        action: 'created',
        repository: { full_name: 'acme/webapp', default_branch: 'main' },
        sender: { login: 'human-user', id: 111, type: 'User' },
        issue: { number: 42 },
        comment: { body: 'stop', user: { login: 'human-user' } },
      };
      const body = JSON.stringify(payload);

      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': nextDeliveryId(),
          'x-hub-signature-256': computeSignature(body, TEST_SECRET),
        },
        payload: body,
      });

      assert.equal(response.statusCode, 202);
      const responseBody = JSON.parse(response.body);
      assert.equal(responseBody.status, 'cancelling');
      assert.equal(cancelEvents.length, 1);
      assert.ok(cancelEvents[0].payload.workItemId.includes('42'));
    });

    it('should detect "cancel" in issue comment', async () => {
      const cancelEvents: WorkCancelledEvent[] = [];
      eventBus.subscribe('WorkCancelled', (event) => {
        cancelEvents.push(event);
      });

      const payload = {
        action: 'created',
        repository: { full_name: 'acme/webapp', default_branch: 'main' },
        sender: { login: 'human-user', id: 111, type: 'User' },
        issue: { number: 99 },
        comment: { body: 'cancel', user: { login: 'human-user' } },
      };
      const body = JSON.stringify(payload);

      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': nextDeliveryId(),
          'x-hub-signature-256': computeSignature(body, TEST_SECRET),
        },
        payload: body,
      });

      assert.equal(response.statusCode, 202);
      assert.equal(JSON.parse(response.body).status, 'cancelling');
      assert.equal(cancelEvents.length, 1);
    });

    it('should detect "abort" in issue comment', async () => {
      const cancelEvents: WorkCancelledEvent[] = [];
      eventBus.subscribe('WorkCancelled', (event) => {
        cancelEvents.push(event);
      });

      const payload = {
        action: 'created',
        repository: { full_name: 'acme/webapp', default_branch: 'main' },
        sender: { login: 'human-user', id: 111, type: 'User' },
        issue: { number: 50 },
        comment: { body: 'abort', user: { login: 'human-user' } },
      };
      const body = JSON.stringify(payload);

      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': nextDeliveryId(),
          'x-hub-signature-256': computeSignature(body, TEST_SECRET),
        },
        payload: body,
      });

      assert.equal(response.statusCode, 202);
      assert.equal(JSON.parse(response.body).status, 'cancelling');
      assert.equal(cancelEvents.length, 1);
    });

    it('should NOT trigger cancellation for non-stop comments', async () => {
      const cancelEvents: WorkCancelledEvent[] = [];
      eventBus.subscribe('WorkCancelled', (event) => {
        cancelEvents.push(event);
      });

      const payload = {
        action: 'created',
        repository: { full_name: 'acme/webapp', default_branch: 'main' },
        sender: { login: 'human-user', id: 111, type: 'User' },
        issue: { number: 42 },
        comment: { body: 'Looks good, please continue!', user: { login: 'human-user' } },
      };
      const body = JSON.stringify(payload);

      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': nextDeliveryId(),
          'x-hub-signature-256': computeSignature(body, TEST_SECRET),
        },
        payload: body,
      });

      assert.equal(response.statusCode, 202);
      const responseBody = JSON.parse(response.body);
      assert.notEqual(responseBody.status, 'cancelling');
      assert.equal(cancelEvents.length, 0, 'No cancellation events should be published');
    });
  });

  describe('Agent identity badge', () => {
    it('formatAgentComment includes bot marker in all comments', () => {
      const comment = formatAgentComment('Test comment');
      assert.ok(comment.includes(getBotMarker()), 'Comment should contain bot marker');
      assert.ok(comment.includes(getBotMarker()), 'Should contain bot marker');
    });
  });

  describe('Instant feedback (execution engine)', () => {
    it('posts GitHub PR comment before execution starts', async () => {
      const bus = createEventBus();
      const logger = createLogger({ level: 'fatal' });
      const postedComments: { repo: string; prNumber: number; body: string }[] = [];

      const mockGithubClient = {
        postPRComment: async (repo: string, prNumber: number, body: string) => {
          postedComments.push({ repo, prNumber, body });
        },
        postInlineComment: async () => {},
        pushBranch: async () => {},
        submitReview: async () => {},
      };

      const mockExecutor: SimpleExecutor = {
        async execute(): Promise<ExecutionResult> {
          // Verify instant feedback was posted BEFORE execution
          assert.equal(postedComments.length, 1, 'Instant feedback should be posted before execution');
          return { status: 'completed', agentResults: [], totalDuration: 10 };
        },
      };

      const unsub = startExecutionEngine({
        eventBus: bus,
        logger,
        simpleExecutor: mockExecutor,
        workflowConfig: makeTestWorkflowConfig(),
        githubClient: mockGithubClient,
      });

      const intakeEvent: IntakeEvent = {
        id: 'aig-test-001',
        timestamp: new Date().toISOString(),
        source: 'github',
        sourceMetadata: {},
        intent: 'review-pr',
        entities: { repo: 'acme/webapp', prNumber: 42, branch: 'main' },
        rawText: 'Test',
      };

      bus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }));

      await new Promise((r) => setTimeout(r, 200));

      assert.equal(postedComments.length, 1, 'Should have posted exactly one instant feedback comment');
      assert.ok(postedComments[0].body.includes('is working on this'), 'Comment should indicate work is starting');
      assert.ok(postedComments[0].body.includes(getBotMarker()), 'Comment should have bot marker');

      unsub();
      bus.removeAllListeners();
    });

    it('posts Linear comment before execution starts', async () => {
      const bus = createEventBus();
      const logger = createLogger({ level: 'fatal' });
      const linearComments: { issueId: string; body: string }[] = [];

      const mockLinearClient = {
        fetchIssue: async () => ({ id: '', identifier: '', title: '', priority: 0, state: { id: '', name: '' }, labels: { nodes: [] }, updatedAt: '' }),
        fetchTeamStates: async () => [],
        fetchActiveIssues: async () => [],
        fetchIssuesByStates: async () => [],
        fetchIssueStatesByIds: async () => [],
        fetchComments: async () => [],
        createComment: async (issueId: string, body: string) => {
          linearComments.push({ issueId, body });
          return 'comment-id';
        },
        updateComment: async () => {},
        updateIssueState: async () => {},
      };

      const mockExecutor: SimpleExecutor = {
        async execute(): Promise<ExecutionResult> {
          return { status: 'completed', agentResults: [], totalDuration: 10 };
        },
      };

      const unsub = startExecutionEngine({
        eventBus: bus,
        logger,
        simpleExecutor: mockExecutor,
        workflowConfig: makeTestWorkflowConfig(),
        linearClient: mockLinearClient,
      });

      const intakeEvent: IntakeEvent = {
        id: 'aig-linear-001',
        timestamp: new Date().toISOString(),
        source: 'linear',
        sourceMetadata: { linearIssueId: 'issue-123' },
        intent: 'custom:linear-todo',
        entities: {},
        rawText: 'Fix bug',
      };

      bus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }));

      await new Promise((r) => setTimeout(r, 200));

      assert.equal(linearComments.length, 1, 'Should have posted Linear instant feedback');
      assert.equal(linearComments[0].issueId, 'issue-123');
      assert.ok(linearComments[0].body.includes('is working on this'), 'Should indicate work starting');

      unsub();
      bus.removeAllListeners();
    });
  });

  describe('WorkCancelled subscription in execution engine', () => {
    it('calls cancellationController.cancelPlan on WorkCancelled event', async () => {
      const bus = createEventBus();
      const logger = createLogger({ level: 'fatal' });
      const cancelledPlans: string[] = [];

      const mockCancellationController = {
        register: () => {},
        cancel: () => true,
        cancelPlan: (planId: string) => {
          cancelledPlans.push(planId);
          return 1;
        },
        unregister: () => {},
        getActiveCount: () => 0,
      };

      const mockExecutor: SimpleExecutor = {
        async execute(): Promise<ExecutionResult> {
          return { status: 'completed', agentResults: [], totalDuration: 10 };
        },
      };

      const unsub = startExecutionEngine({
        eventBus: bus,
        logger,
        simpleExecutor: mockExecutor,
        workflowConfig: makeTestWorkflowConfig(),
        cancellationController: mockCancellationController,
      });

      bus.publish(createDomainEvent('WorkCancelled', {
        workItemId: 'pr-42',
        cancellationReason: 'User requested stop',
      }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(cancelledPlans.length, 1);
      assert.equal(cancelledPlans[0], 'pr-42');

      unsub();
      bus.removeAllListeners();
    });
  });
});
