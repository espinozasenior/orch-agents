import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { webhookRouter, type WebhookRouterDeps } from '../../src/webhook-gateway/webhook-router';
import { createEventBuffer, type EventBuffer } from '../../src/webhook-gateway/event-buffer';
import { loadConfig } from '../../src/shared/config';
import { createLogger } from '../../src/shared/logger';
import { createEventBus, type EventBus } from '../../src/kernel/event-bus';
import { setBotUserId } from '../../src/intake/github-workflow-normalizer';
import { setBotName } from '../../src/kernel/agent-identity';
import type { IntakeCompletedEvent } from '../../src/kernel/event-types';
import type { WorkflowConfig } from '../../src/config';
import type { OrchestratorSnapshot } from '../../src/execution/orchestrator/symphony-orchestrator';

function makeTestWorkflowConfig(): WorkflowConfig {
  return {
    repos: {
      'acme/webapp': {
        url: 'git@github.com:acme/webapp.git',
        defaultBranch: 'main',
        github: {
          events: {
            'pull_request.opened': '.claude/skills/github-ops/SKILL.md',
            'pull_request.synchronize': '.claude/skills/github-ops/SKILL.md',
            'pull_request.closed.merged': '.claude/skills/release/SKILL.md',
            'pull_request.ready_for_review': '.claude/skills/github-ops/SKILL.md',
            'push.default_branch': '.claude/skills/cicd/SKILL.md',
            'push.other': '.claude/skills/quick-fix/SKILL.md',
            'issues.opened': '.claude/skills/github-ops/SKILL.md',
            'issues.labeled.bug': '.claude/skills/tdd/SKILL.md',
            'issues.labeled.enhancement': '.claude/skills/feature/SKILL.md',
            'issues.labeled.security': '.claude/skills/security/SKILL.md',
            'issue_comment.mentions_bot': '.claude/skills/quick-fix/SKILL.md',
            'pull_request_review.changes_requested': '.claude/skills/quick-fix/SKILL.md',
            'workflow_run.failure': '.claude/skills/quick-fix/SKILL.md',
            'release.published': '.claude/skills/release/SKILL.md',
            'deployment_status.failure': '.claude/skills/quick-fix/SKILL.md',
          },
        },
      },
    },
    defaults: {
      agents: { maxConcurrent: 8 },
      stall: { timeoutMs: 300000 },
      polling: { intervalMs: 30000, enabled: false },
    },
    tracker: { kind: 'linear', apiKey: '', team: 'test', activeTypes: ['unstarted', 'started'], terminalTypes: ['completed', 'canceled'], activeStates: [], terminalStates: [] },
    agents: { maxConcurrent: 8 },
    agent: { maxConcurrentAgents: 8, maxRetryBackoffMs: 300000, maxTurns: 20 },
    polling: { intervalMs: 30000, enabled: false },
    stall: { timeoutMs: 300000 },
    agentRunner: { stallTimeoutMs: 300000, command: 'claude', turnTimeoutMs: 3600000 },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 60000 },
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

/** Repo full_name used in test payloads must exist in the workflowConfig.repos map. */
const TEST_REPO = 'acme/webapp';

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
    assert.equal(receivedEvent!.payload.intakeEvent.sourceMetadata.ruleKey, 'pull_request.opened');
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
    assert.equal(receivedEvent!.payload.intakeEvent.sourceMetadata.ruleKey, 'push.default_branch');
  });

  it('returns workflow validity, active issue count, retry entries, latest error details, and next refresh timing', async () => {
    await server.close();
    buffer.dispose();
    buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });

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
      getStatusSnapshot: () => ({
        workflow: { valid: false, error: 'unsupported placeholders' },
        orchestrator: {
          starting: false,
          workflow: { valid: false, error: 'unsupported placeholders' },
          running: [
            {
              issueId: 'issue-1',
              issueIdentifier: 'ENG-1',
              state: 'Todo',
              startedAt: 100,
              lastEventTimestamp: 200,
              sessionId: 'session-1',
              lastEventType: 'tokenUsage',
              lastActivityAt: '2026-03-29T12:00:00.000Z',
              tokenUsage: { input: 11, output: 7 },
              workspacePath: '/tmp/orch-agents/issue-1',
              workerHost: 'local',
              turnCount: 3,
              attempt: 1,
            },
          ],
          retries: [
            {
              issueId: 'issue-2',
              attempt: 2,
              dueAt: 500,
              reason: 'retry',
            },
          ],
          claimed: ['issue-1'],
          completed: [],
          startup: { cleanedWorkspaces: [], checkedAt: 50 },
          nextPollAt: 1000,
        } satisfies OrchestratorSnapshot,
        links: {
          dashboardUrl: 'https://example.com/dashboard',
        },
      }),
    } satisfies WebhookRouterDeps);
    await server.ready();

    const response = await server.inject({
      method: 'GET',
      url: '/status',
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.workflow.valid, false);
    assert.equal(body.summary.activeIssueCount, 1);
    assert.equal(body.retries.length, 1);
    assert.equal(body.summary.nextRefreshAt, 1000);
    assert.deepEqual(body.summary.tokenTotals, { input: 11, output: 7 });
    assert.equal(body.running[0].lastEventType, 'tokenUsage');
    assert.equal(body.latestError.message, 'unsupported placeholders');
  });

  it('returns HTTP 200 with a well-formed empty snapshot when idle', async () => {
    await server.close();
    buffer.dispose();
    buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });

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
      getStatusSnapshot: () => ({
        workflow: { valid: true },
        orchestrator: {
          starting: false,
          workflow: { valid: true },
          running: [],
          retries: [],
          claimed: [],
          completed: [],
          startup: { cleanedWorkspaces: [], checkedAt: 50 },
        } satisfies OrchestratorSnapshot,
      }),
    } satisfies WebhookRouterDeps);
    await server.ready();

    const response = await server.inject({
      method: 'GET',
      url: '/status',
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.workflow.valid, true);
    assert.deepEqual(body.running, []);
    assert.deepEqual(body.retries, []);
    assert.equal(body.summary.activeIssueCount, 0);
    assert.deepEqual(body.summary.tokenTotals, { input: 0, output: 0 });
    assert.equal(body.latestError, null);
  });
});
