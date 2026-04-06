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
import { createEventBus, type EventBus } from '../src/shared/event-bus';
import { setBotUserId } from '../src/intake/github-workflow-normalizer';
import type { WorkflowConfig } from '../src/integration/linear/workflow-parser';
import type { WorkCancelledEvent } from '../src/shared/event-types';
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

});
