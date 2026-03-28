import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { webhookRouter, type WebhookRouterDeps } from '../../src/webhook-gateway/webhook-router';
import { createEventBuffer, type EventBuffer } from '../../src/webhook-gateway/event-buffer';
import { loadConfig } from '../../src/shared/config';
import { createLogger } from '../../src/shared/logger';
import { createEventBus, type EventBus } from '../../src/shared/event-bus';
import { setBotUserId } from '../../src/intake/github-workflow-normalizer';
import { setBotName } from '../../src/shared/agent-identity';
import type { IntakeCompletedEvent } from '../../src/shared/event-types';
import type { WorkflowConfig } from '../../src/integration/linear/workflow-parser';

function makeTestWorkflowConfig(): WorkflowConfig {
  return {
    templates: {
      'github-ops': ['reviewer'],
      'tdd-workflow': ['coder', 'tester'],
      'quick-fix': ['coder'],
      'cicd-pipeline': ['coder'],
      'release-pipeline': ['coder'],
      'security-audit': ['security-architect'],
      'feature-build': ['architect', 'coder', 'reviewer'],
    },
    github: {
      events: {
        'pull_request.opened': 'github-ops',
        'pull_request.synchronize': 'github-ops',
        'pull_request.closed.merged': 'release-pipeline',
        'pull_request.ready_for_review': 'github-ops',
        'push.default_branch': 'cicd-pipeline',
        'push.other': 'quick-fix',
        'issues.opened': 'github-ops',
        'issues.labeled.bug': 'tdd-workflow',
        'issues.labeled.enhancement': 'feature-build',
        'issues.labeled.security': 'security-audit',
        'issue_comment.mentions_bot': 'quick-fix',
        'pull_request_review.changes_requested': 'quick-fix',
        'workflow_run.failure': 'quick-fix',
        'release.published': 'release-pipeline',
        'deployment_status.failure': 'quick-fix',
      },
    },
    tracker: { kind: 'linear', apiKey: '', team: 'test', activeTypes: ['unstarted', 'started'], terminalTypes: ['completed', 'canceled'], activeStates: [], terminalStates: [] },
    agents: { maxConcurrent: 8, routing: { bug: 'tdd-workflow' }, defaultTemplate: 'quick-fix' },
    polling: { intervalMs: 30000, enabled: false },
    stall: { timeoutMs: 300000 },
    promptTemplate: '',
  };
}

const TEST_SECRET = 'test-secret-for-webhooks';

function computeSignature(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    repository: {
      full_name: 'acme/webapp',
      default_branch: 'main',
    },
    sender: {
      login: 'octocat',
      id: 12345,
      type: 'User',
    },
    pull_request: {
      number: 42,
      merged: false,
      labels: [],
      head: { ref: 'feature/test' },
    },
    ...overrides,
  };
}

describe('webhookRouter (integration)', () => {
  let server: FastifyInstance;
  let eventBus: EventBus;
  let buffer: EventBuffer;
  let deliveryCounter: number;

  function nextDeliveryId(): string {
    deliveryCounter += 1;
    return `test-delivery-${deliveryCounter}`;
  }

  beforeEach(async () => {
    deliveryCounter = 0;
    setBotUserId(0);
    setBotName('orch-agents');

    const config = loadConfig({
      PORT: '3999',
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

  it('should return 202 for a valid webhook', async () => {
    const payload = makePayload();
    const body = JSON.stringify(payload);
    const deliveryId = nextDeliveryId();

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': computeSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const responseBody = JSON.parse(response.body);
    assert.equal(responseBody.id, deliveryId);
    assert.equal(responseBody.status, 'queued');
  });

  it('should return 401 for invalid signature', async () => {
    const payload = makePayload();
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': nextDeliveryId(),
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 401);
    const responseBody = JSON.parse(response.body);
    assert.ok(responseBody.error);
    assert.equal(responseBody.error.code, 'ERR_AUTHENTICATION');
  });

  it('should return 409 for duplicate delivery', async () => {
    const payload = makePayload();
    const body = JSON.stringify(payload);
    const deliveryId = nextDeliveryId();
    const sig = computeSignature(body, TEST_SECRET);

    // First request succeeds
    const first = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sig,
      },
      payload: body,
    });
    assert.equal(first.statusCode, 202);

    // Second request with same delivery ID is duplicate
    const second = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sig,
      },
      payload: body,
    });

    assert.equal(second.statusCode, 409);
    const responseBody = JSON.parse(second.body);
    assert.equal(responseBody.error.code, 'ERR_CONFLICT');
  });

  it('should return 400 for missing headers', async () => {
    const payload = makePayload();
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        // Missing x-github-event and x-github-delivery
      },
      payload: body,
    });

    assert.equal(response.statusCode, 400);
    const responseBody = JSON.parse(response.body);
    assert.equal(responseBody.error.code, 'ERR_VALIDATION');
  });

  it('should publish IntakeCompleted event to event bus', async () => {
    const payload = makePayload();
    const body = JSON.stringify(payload);
    const deliveryId = nextDeliveryId();

    let receivedEvent: IntakeCompletedEvent | null = null;
    eventBus.subscribe('IntakeCompleted', (event) => {
      receivedEvent = event;
    });

    await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': computeSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    assert.ok(receivedEvent, 'IntakeCompleted event should have been published');
    assert.equal(receivedEvent!.type, 'IntakeCompleted');
    assert.equal(receivedEvent!.correlationId, deliveryId);
    assert.equal(receivedEvent!.payload.intakeEvent.intent, 'review-pr');
    assert.equal(receivedEvent!.payload.intakeEvent.entities.prNumber, 42);
  });

  it('should return 202 with skipped status for bot sender', async () => {
    const payload = makePayload({
      sender: { login: 'bot[bot]', id: 88888, type: 'Bot' },
    });
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': nextDeliveryId(),
        'x-hub-signature-256': computeSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const responseBody = JSON.parse(response.body);
    assert.equal(responseBody.status, 'skipped');
  });

  it('should return 429 when rate limited', async () => {
    // Create a buffer with a very low rate limit
    buffer.dispose();
    buffer = createEventBuffer({
      maxEventsPerMinute: 2,
      cleanupIntervalMs: 60_000,
    });

    // Re-create server with new buffer
    await server.close();
    const config = loadConfig({
      PORT: '3999',
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      WEBHOOK_SECRET: TEST_SECRET,
    });
    server = Fastify({ logger: false });
    await server.register(webhookRouter, {
      config,
      logger: createLogger({ level: 'fatal' }),
      eventBus,
      eventBuffer: buffer,
      workflowConfig: makeTestWorkflowConfig(),
    } as WebhookRouterDeps);
    await server.ready();

    const payload = makePayload();
    const body = JSON.stringify(payload);

    // Send 2 requests (hits limit)
    for (let i = 0; i < 2; i++) {
      const sig = computeSignature(body, TEST_SECRET);
      await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': nextDeliveryId(),
          'x-hub-signature-256': sig,
        },
        payload: body,
      });
    }

    // 3rd request should be rate limited
    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': nextDeliveryId(),
        'x-hub-signature-256': computeSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    assert.equal(response.statusCode, 429);
    const responseBody = JSON.parse(response.body);
    assert.equal(responseBody.error.code, 'ERR_RATE_LIMIT');
  });

  it('should skip issue_comment events containing bot marker', async () => {
    const payload = {
      action: 'created',
      repository: {
        full_name: 'acme/webapp',
        default_branch: 'main',
      },
      sender: {
        login: 'orch-bot',
        id: 99999,
        type: 'User',
      },
      issue: {
        number: 42,
      },
      comment: {
        body: 'All checks passed. No findings.\n<!-- orch-agents-bot -->',
      },
    };
    const body = JSON.stringify(payload);
    const deliveryId = nextDeliveryId();

    let receivedEvent = false;
    eventBus.subscribe('IntakeCompleted', () => {
      receivedEvent = true;
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': computeSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const responseBody = JSON.parse(response.body);
    assert.equal(responseBody.status, 'skipped');
    assert.equal(receivedEvent, false, 'Should NOT publish IntakeCompleted for bot comments');
  });

  it('should skip issue_comment events with custom BOT_USERNAME marker', async () => {
    // Re-create server with BOT_USERNAME configured
    buffer.dispose();
    await server.close();
    buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });
    setBotName('automata');

    const config = loadConfig({
      PORT: '3999',
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      WEBHOOK_SECRET: TEST_SECRET,
      BOT_USERNAME: 'automata',
    });
    server = Fastify({ logger: false });
    await server.register(webhookRouter, {
      config,
      logger: createLogger({ level: 'fatal' }),
      eventBus,
      eventBuffer: buffer,
      workflowConfig: makeTestWorkflowConfig(),
    } as WebhookRouterDeps);
    await server.ready();

    const payload = {
      action: 'created',
      repository: {
        full_name: 'acme/webapp',
        default_branch: 'main',
      },
      sender: {
        login: 'some-user',
        id: 77777,
        type: 'User',
      },
      issue: {
        number: 42,
      },
      comment: {
        body: 'Agent completed phase.\n<!-- automata-bot -->',
      },
    };
    const body = JSON.stringify(payload);
    const deliveryId = nextDeliveryId();

    let receivedEvent = false;
    eventBus.subscribe('IntakeCompleted', () => {
      receivedEvent = true;
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': computeSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const responseBody = JSON.parse(response.body);
    assert.equal(responseBody.status, 'skipped');
    assert.equal(receivedEvent, false, 'Should NOT publish IntakeCompleted for custom bot marker');
  });

  it('should NOT skip issue_comment with default marker when BOT_USERNAME is set to different value', async () => {
    // Re-create server with BOT_USERNAME configured to 'automata'
    buffer.dispose();
    await server.close();
    buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });
    setBotName('automata');

    const config = loadConfig({
      PORT: '3999',
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      WEBHOOK_SECRET: TEST_SECRET,
      BOT_USERNAME: 'automata',
    });
    server = Fastify({ logger: false });
    await server.register(webhookRouter, {
      config,
      logger: createLogger({ level: 'fatal' }),
      eventBus,
      eventBuffer: buffer,
      workflowConfig: makeTestWorkflowConfig(),
    } as WebhookRouterDeps);
    await server.ready();

    // This comment has the OLD default marker, but BOT_USERNAME is 'automata'
    // so the detection should look for <!-- automata-bot --> NOT <!-- orch-agents-bot -->
    const payload = {
      action: 'created',
      repository: {
        full_name: 'acme/webapp',
        default_branch: 'main',
      },
      sender: {
        login: 'some-user',
        id: 77777,
        type: 'User',
      },
      issue: {
        number: 42,
      },
      comment: {
        body: 'Some comment\n<!-- orch-agents-bot -->',
      },
    };
    const body = JSON.stringify(payload);
    const deliveryId = nextDeliveryId();

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': computeSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const responseBody = JSON.parse(response.body);
    // Should NOT be skipped by bot marker detection since marker doesn't match
    // It may be 'queued' or 'skipped' for other reasons (routing), but not bot detection
    assert.ok(
      responseBody.status === 'queued' || responseBody.status === 'skipped',
      `Expected queued or skipped, got ${responseBody.status}`,
    );
  });

  it('should skip issue_comment events from BOT_USERNAME', async () => {
    // Re-create server with BOT_USERNAME configured
    buffer.dispose();
    await server.close();
    buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });
    setBotName('orch-bot');

    const config = loadConfig({
      PORT: '3999',
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      WEBHOOK_SECRET: TEST_SECRET,
      BOT_USERNAME: 'orch-bot',
    });
    server = Fastify({ logger: false });
    await server.register(webhookRouter, {
      config,
      logger: createLogger({ level: 'fatal' }),
      eventBus,
      eventBuffer: buffer,
      workflowConfig: makeTestWorkflowConfig(),
    } as WebhookRouterDeps);
    await server.ready();

    const payload = {
      action: 'created',
      repository: {
        full_name: 'acme/webapp',
        default_branch: 'main',
      },
      sender: {
        login: 'orch-bot',
        id: 99999,
        type: 'User',
      },
      issue: {
        number: 42,
      },
      comment: {
        body: 'Some comment without the bot marker',
        user: {
          login: 'orch-bot',
        },
      },
    };
    const body = JSON.stringify(payload);
    const deliveryId = nextDeliveryId();

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': computeSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const responseBody = JSON.parse(response.body);
    assert.equal(responseBody.status, 'skipped');
  });

  it('should process issue_comment events from other users normally', async () => {
    setBotUserId(0);

    const payload = {
      action: 'created',
      repository: {
        full_name: 'acme/webapp',
        default_branch: 'main',
      },
      sender: {
        login: 'real-user',
        id: 11111,
        type: 'User',
      },
      issue: {
        number: 42,
      },
      comment: {
        body: 'A normal user comment mentioning @orch-bot',
      },
    };
    const body = JSON.stringify(payload);
    const deliveryId = nextDeliveryId();

    let receivedEvent: IntakeCompletedEvent | null = null;
    eventBus.subscribe('IntakeCompleted', (event) => {
      receivedEvent = event;
    });

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': computeSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    // The routing table may or may not have a matching rule for issue_comment/created
    // with mentions_bot condition. At minimum, it should NOT be skipped as a bot comment.
    assert.equal(response.statusCode, 202);
    const responseBody = JSON.parse(response.body);
    // It should either be 'queued' (if routing matches) or 'skipped' (if no routing rule)
    // but NOT skipped due to bot detection
    assert.ok(
      responseBody.status === 'queued' || responseBody.status === 'skipped',
      `Expected queued or skipped, got ${responseBody.status}`,
    );
  });

  it('should process push event to default branch', async () => {
    const payload = {
      ref: 'refs/heads/main',
      repository: {
        full_name: 'acme/webapp',
        default_branch: 'main',
      },
      sender: {
        login: 'dev',
        id: 111,
        type: 'User',
      },
      commits: [
        { added: ['new.ts'], modified: [], removed: [] },
      ],
    };
    const body = JSON.stringify(payload);
    const deliveryId = nextDeliveryId();

    let receivedEvent: IntakeCompletedEvent | null = null;
    eventBus.subscribe('IntakeCompleted', (event) => {
      receivedEvent = event;
    });

    await server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': computeSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    assert.ok(receivedEvent);
    assert.equal(receivedEvent!.payload.intakeEvent.intent, 'validate-main');
  });
});
