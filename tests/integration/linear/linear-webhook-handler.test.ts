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
import { createEventBus, type EventBus } from '../../../src/kernel/event-bus';
import {
  setWorkflowConfig,
  resetWorkflowConfig,
  setLinearBotUserId,
} from '../../../src/integration/linear/linear-normalizer';
import type { WorkflowConfig } from '../../../src/config';
import type { IntakeCompletedEvent, AgentPromptedEvent, WorkCancelledEvent } from '../../../src/kernel/event-types';
import type { IntakeEvent } from '../../../src/types';
import type { LinearClient } from '../../../src/integration/linear/linear-client';

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
    assert.equal(capturedEvent!.payload.intakeEvent.sourceMetadata.intent, 'custom:linear-todo');
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

  // ---------------------------------------------------------------------------
  // Phase 7D: AgentSessionEvent tests
  // ---------------------------------------------------------------------------

  function makeAgentSessionPayload(
    action: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: 'AgentSessionEvent',
      action,
      createdAt: '2026-03-29T00:00:00.000Z',
      data: { id: 'issue-1', identifier: 'ENG-42', title: 'Fix bug', priority: 2 },
      agentSession: {
        id: 'session-abc',
        issue: { id: 'issue-1', identifier: 'ENG-42', title: 'Fix bug' },
      },
      promptContext: '<issue identifier="ENG-42"><title>Fix bug</title><description>broken</description></issue>',
      ...overrides,
    };
  }

  function createMockLinearClient(overrides: Partial<LinearClient> = {}): LinearClient {
    return {
      fetchIssue: async () => ({} as never),
      fetchTeamStates: async () => [],
      fetchActiveIssues: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      fetchComments: async () => [],
      createComment: async () => '',
      updateComment: async () => {},
      updateIssueState: async () => {},
      createAgentActivity: async () => 'activity-1',
      agentSessionUpdate: async () => {},
      agentSessionCreateOnIssue: async () => '',
      agentSessionCreateOnComment: async () => '',
      fetchSessionActivities: async () => ({ activities: [], hasNextPage: false }),
      issueRepositorySuggestions: async () => [],
      ...overrides,
    };
  }

  function createTestServerWithLinearClient(
    linearClient: LinearClient,
    configOverrides: Record<string, string> = {},
  ) {
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
        linearClient,
      } as LinearWebhookHandlerDeps);
      await server.ready();
    };
  }

  // 7D: AgentSessionEvent 'created' emits thought activity and publishes AgentPrompted
  it('should emit thought activity and publish AgentPrompted for AgentSessionEvent created', async () => {
    const activityCalls: Array<{ sessionId: string; content: unknown }> = [];
    const mockClient = createMockLinearClient({
      createAgentActivity: async (sessionId, content) => {
        activityCalls.push({ sessionId, content });
        return 'activity-1';
      },
    });
    await createTestServerWithLinearClient(mockClient)();

    let capturedEvent: AgentPromptedEvent | null = null;
    eventBus.subscribe('AgentPrompted', (event) => {
      capturedEvent = event;
    });

    const payload = makeAgentSessionPayload('created');
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-session-1',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const json = JSON.parse(response.body);
    assert.equal(json.status, 'prompted');

    // Thought activity was emitted
    assert.equal(activityCalls.length, 1);
    assert.equal(activityCalls[0]!.sessionId, 'session-abc');
    assert.deepStrictEqual(activityCalls[0]!.content, { type: 'thought', body: 'Analyzing your request...' });

    // AgentPrompted was published
    assert.ok(capturedEvent);
    assert.equal(capturedEvent!.payload.agentSessionId, 'session-abc');
  });

  // 7D: AgentSessionEvent 'created' publishes AgentPrompted with issueId
  it('should publish AgentPrompted with issueId for AgentSessionEvent created', async () => {
    const mockClient = createMockLinearClient();
    await createTestServerWithLinearClient(mockClient)();

    let capturedEvent: AgentPromptedEvent | null = null;
    eventBus.subscribe('AgentPrompted', (event) => {
      capturedEvent = event;
    });

    const payload = makeAgentSessionPayload('created');
    const body = JSON.stringify(payload);

    await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-session-meta',
      },
      payload: body,
    });

    assert.ok(capturedEvent);
    assert.equal(capturedEvent!.payload.agentSessionId, 'session-abc');
    assert.equal(capturedEvent!.payload.issueId, 'issue-1');
  });

  // 7D: AgentSessionEvent 'prompted' publishes AgentPrompted event with body
  it('should publish AgentPrompted for AgentSessionEvent prompted', async () => {
    const mockClient = createMockLinearClient();
    await createTestServerWithLinearClient(mockClient)();

    let capturedEvent: AgentPromptedEvent | null = null;
    eventBus.subscribe('AgentPrompted', (event) => {
      capturedEvent = event;
    });

    const payload = makeAgentSessionPayload('prompted', {
      agentActivity: { body: 'Can you also fix the tests?', signal: null },
    });
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-session-prompted',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const json = JSON.parse(response.body);
    assert.equal(json.status, 'queued');

    assert.ok(capturedEvent);
    assert.equal(capturedEvent!.payload.agentSessionId, 'session-abc');
    assert.equal(capturedEvent!.payload.issueId, 'issue-1');
    assert.equal(capturedEvent!.payload.body, 'Can you also fix the tests?');
  });

  // 7D: AgentSessionEvent 'prompted' with stop signal publishes WorkCancelled and emits response
  it('should publish WorkCancelled and emit response for stop signal', async () => {
    const activityCalls: Array<{ sessionId: string; content: unknown }> = [];
    const mockClient = createMockLinearClient({
      createAgentActivity: async (sessionId, content) => {
        activityCalls.push({ sessionId, content });
        return 'activity-stop';
      },
    });
    await createTestServerWithLinearClient(mockClient)();

    let cancelledEvent: WorkCancelledEvent | null = null;
    eventBus.subscribe('WorkCancelled', (event) => {
      cancelledEvent = event;
    });

    const payload = makeAgentSessionPayload('prompted', {
      agentActivity: { body: '', signal: 'stop' },
    });
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-session-stop',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const json = JSON.parse(response.body);
    assert.equal(json.status, 'cancelling');

    // WorkCancelled was published
    assert.ok(cancelledEvent);
    assert.equal(cancelledEvent!.payload.workItemId, 'linear-session-session-abc');
    assert.ok(cancelledEvent!.payload.cancellationReason.includes('stop signal'));

    // Response activity was emitted
    assert.equal(activityCalls.length, 1);
    assert.deepStrictEqual(activityCalls[0]!.content, {
      type: 'response',
      body: 'Stopped. No further changes will be made.',
    });
  });

  // 7D: Unknown AgentSessionEvent action returns 202 skipped
  it('should return 202 skipped for unknown AgentSessionEvent action', async () => {
    const mockClient = createMockLinearClient();
    await createTestServerWithLinearClient(mockClient)();

    const payload = makeAgentSessionPayload('unknown_action');
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-session-unknown',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const json = JSON.parse(response.body);
    assert.equal(json.status, 'skipped');
  });

  // 7D: Issue payload regression test (continues to work unchanged)
  it('should still process Issue payloads after AgentSessionEvent handler added (regression)', async () => {
    const mockClient = createMockLinearClient();
    await createTestServerWithLinearClient(mockClient)();

    let capturedEvent: IntakeCompletedEvent | null = null;
    eventBus.subscribe('IntakeCompleted', (event) => {
      capturedEvent = event;
    });

    const payload = makeLinearPayload();
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-regression-1',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    assert.ok(capturedEvent);
    assert.equal(capturedEvent!.payload.intakeEvent.source, 'linear');
    assert.equal(capturedEvent!.payload.intakeEvent.sourceMetadata.intent, 'custom:linear-todo');
  });

  // 7D: Thought activity failure does NOT block AgentPrompted dispatch
  it('should dispatch AgentPrompted even when thought activity emission fails', async () => {
    const mockClient = createMockLinearClient({
      createAgentActivity: async () => {
        throw new Error('Linear API timeout');
      },
    });
    await createTestServerWithLinearClient(mockClient)();

    let capturedEvent: AgentPromptedEvent | null = null;
    eventBus.subscribe('AgentPrompted', (event) => {
      capturedEvent = event;
    });

    const payload = makeAgentSessionPayload('created');
    const body = JSON.stringify(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': computeLinearSignature(body, TEST_SECRET),
        'linear-delivery': 'delivery-session-fail-activity',
      },
      payload: body,
    });

    assert.equal(response.statusCode, 202);
    const json = JSON.parse(response.body);
    assert.equal(json.status, 'prompted');

    // AgentPrompted was still published even though thought emission failed
    assert.ok(capturedEvent);
    assert.equal(capturedEvent!.payload.agentSessionId, 'session-abc');
  });

  // 7D: AgentSessionEvent dedup via event buffer (FR-7D.07)
  it('should deduplicate AgentSessionEvent via event buffer', async () => {
    const mockClient = createMockLinearClient();
    await createTestServerWithLinearClient(mockClient)();

    const payload = makeAgentSessionPayload('created');
    const body = JSON.stringify(payload);
    const sig = computeLinearSignature(body, TEST_SECRET);

    // First request: 202 queued
    const r1 = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': sig,
        'linear-delivery': 'delivery-session-dup-1',
      },
      payload: body,
    });
    assert.equal(r1.statusCode, 202);

    // Second request with same payload: 409 duplicate
    const r2 = await server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': sig,
        'linear-delivery': 'delivery-session-dup-2',
      },
      payload: body,
    });
    assert.equal(r2.statusCode, 409);
  });
});
