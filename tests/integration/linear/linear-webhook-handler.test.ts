/**
 * Tests for LinearWebhookHandler -- integration tests with Fastify.
 *
 * Covers: AC1, AC2, AC10 (feature flag), dedup, bot skip.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  linearWebhookHandler,
  type LinearWebhookHandlerDeps,
} from '../../../src/integration/linear/linear-webhook-handler';
import { createEventBuffer, type EventBuffer } from '../../../src/webhook-gateway/event-buffer';
import { loadConfig, type AppConfig } from '../../../src/shared/config';
import { createLogger } from '../../../src/shared/logger';
import { createEventBus, type EventBus } from '../../../src/shared/event-bus';
import {
  setWorkflowConfig,
  resetWorkflowConfig,
  setLinearBotUserId,
} from '../../../src/integration/linear/linear-normalizer';
import type { WorkflowConfig } from '../../../src/integration/linear/workflow-parser';
import type { IntakeCompletedEvent } from '../../../src/shared/event-types';
import type { IntakeEvent } from '../../../src/types';

// ---------------------------------------------------------------------------
// Test workflow config
// ---------------------------------------------------------------------------

const TEST_WORKFLOW_CONFIG: WorkflowConfig = {
  tracker: {
    kind: 'linear',
    apiKey: '',
    team: 'ENG',
    activeTypes: ['unstarted', 'started'],
    terminalTypes: ['completed', 'canceled'],
    activeStates: [],
    terminalStates: [],
  },
  agents: {
    maxConcurrent: 8,
    routing: {
      bug: 'tdd-workflow',
      feature: 'feature-build',
      security: 'security-audit',
      refactor: 'sparc-full',
    },
    defaultTemplate: 'quick-fix',
  },
  polling: { intervalMs: 30_000, enabled: false },
  stall: { timeoutMs: 300_000 },
  promptTemplate: '',
};

const TEST_SECRET = 'test-linear-webhook-secret';

function computeLinearSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function makeLinearPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'update',
    type: 'Issue',
    createdAt: '2026-01-01T00:00:00.000Z',
    actor: { id: 'actor-1', name: 'Human' },
    data: {
      id: 'issue-1',
      identifier: 'ENG-42',
      title: 'Fix the bug',
      description: 'Something broken',
      url: 'https://linear.app/team/issue/ENG-42',
      priority: 2,
      state: { id: 'state-1', name: 'Todo', type: 'unstarted' },
      labels: [],
      assignee: null,
      creator: { id: 'creator-1', name: 'Jane' },
      team: { id: 'team-1', key: 'ENG' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    updatedFrom: { state: { id: 'old-state' } },
    ...overrides,
  };
}

describe('linearWebhookHandler (integration)', () => {
  let server: FastifyInstance;
  let eventBus: EventBus;
  let buffer: EventBuffer;

  function createTestServer(configOverrides: Record<string, string> = {}) {
    return async () => {
      setWorkflowConfig(TEST_WORKFLOW_CONFIG);
      setLinearBotUserId('');

      const config = loadConfig({
        PORT: '3998',
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        WEBHOOK_SECRET: 'github-secret',
        LINEAR_ENABLED: 'true',
        LINEAR_WEBHOOK_SECRET: TEST_SECRET,
        ...configOverrides,
      });
      const logger = createLogger({ level: 'fatal' });
      eventBus = createEventBus();
      buffer = createEventBuffer({ cleanupIntervalMs: 60_000 });

      server = Fastify({ logger: false });
      await server.register(linearWebhookHandler, {
        config,
        logger,
        eventBus,
        eventBuffer: buffer,
      } as LinearWebhookHandlerDeps);
      await server.ready();
    };
  }

  afterEach(async () => {
    resetWorkflowConfig();
    if (buffer) buffer.dispose();
    if (eventBus) eventBus.removeAllListeners();
    if (server) await server.close();
  });

  // AC1: Valid payload -> 202 Accepted
  it('should return 202 for a valid Linear webhook (AC1)', async () => {
    await createTestServer()();

    const payload = makeLinearPayload();
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-1',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const json = JSON.parse(response.body);
    assert.equal(json.status, 'queued');
  });

  // AC1: Publishes IntakeCompleted event
  it('should publish IntakeCompleted event for valid Linear webhook', async () => {
    await createTestServer()();

    let capturedEvent: IntakeCompletedEvent | null = null;
    eventBus.subscribe('IntakeCompleted', (event) => {
      capturedEvent = event;
    });

    const payload = makeLinearPayload();
    const body = JSON.stringify(payload);

    await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-2',
      },
      payload: body,
    });

    assert.ok(capturedEvent);
    assert.equal(capturedEvent!.payload.intakeEvent.source, 'linear');
    assert.equal(capturedEvent!.payload.intakeEvent.intent, 'custom:linear-todo');
  });

  it('should hand off normalized Linear intake to Symphony when configured', async () => {
    await createTestServer()();

    const handedOff: IntakeEvent[] = [];
    const handoffServer = Fastify({ logger: false });
    await handoffServer.register(linearWebhookHandler, {
      config: loadConfig({
        PORT: '3999',
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        WEBHOOK_SECRET: 'github-secret',
        LINEAR_ENABLED: 'true',
        LINEAR_WEBHOOK_SECRET: TEST_SECRET,
      }),
      logger: createLogger({ level: 'fatal' }),
      eventBus: createEventBus(),
      eventBuffer: createEventBuffer({ cleanupIntervalMs: 60_000 }),
      onLinearIntake: async (intakeEvent) => {
        handedOff.push(intakeEvent);
      },
    } as LinearWebhookHandlerDeps);
    await handoffServer.ready();

    const payload = makeLinearPayload();
    const body = JSON.stringify(payload);

    const response = await handoffServer.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-handoff',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    assert.equal(handedOff.length, 1);
    assert.equal(handedOff[0]?.source, 'linear');
    assert.equal(handedOff[0]?.sourceMetadata.linearIssueId, 'issue-1');

    await handoffServer.close();
  });

  // AC2: Invalid signature -> 401
  it('should return 401 for invalid signature (AC2)', async () => {
    await createTestServer()();

    const payload = makeLinearPayload();
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': 'invalid-signature',
        'linear-delivery': 'delivery-3',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 401);
  });

  // AC2: Missing signature -> 401
  it('should return 401 for missing signature (AC2)', async () => {
    await createTestServer()();

    const payload = makeLinearPayload();
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-delivery': 'delivery-4',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 401);
  });

  // AC10: Disabled -> 404
  it('should return 404 when LINEAR_ENABLED=false (AC10)', async () => {
    await createTestServer({ LINEAR_ENABLED: 'false' })();

    const payload = makeLinearPayload();
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
      },
      payload: body,
    });

    assert.equal(response.statusCode, 404);
  });

  // Dedup: 409 on duplicate delivery
  it('should return 409 on duplicate delivery', async () => {
    await createTestServer()();

    const payload = makeLinearPayload();
    const body = JSON.stringify(payload);
    const sig = computeLinearSignature(body, TEST_SECRET);

    // First request: 202
    const r1 = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': sig,
        'linear-delivery': 'delivery-dup',
      },
      payload: body,
    });
    assert.equal(r1.statusCode, 202);

    // Second request with same payload (same dedup key): 409
    const r2 = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': sig,
        'linear-delivery': 'delivery-dup-2',
      },
      payload: body,
    });
    assert.equal(r2.statusCode, 409);
  });

  // Non-Issue event -> 202 skipped
  it('should return 202 skipped for non-Issue events', async () => {
    await createTestServer()();

    const payload = makeLinearPayload({ type: 'Comment' });
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-5',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const json = JSON.parse(response.body);
    assert.equal(json.status, 'skipped');
  });

  // Bot event -> 202 skipped
  it('should return 202 skipped for bot events', async () => {
    await createTestServer({ LINEAR_BOT_USER_ID: 'actor-1' })();

    const payload = makeLinearPayload();
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-6',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const json = JSON.parse(response.body);
    assert.equal(json.status, 'skipped');
  });
});
