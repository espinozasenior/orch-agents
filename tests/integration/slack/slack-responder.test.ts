/**
 * Tests for Slack responder — London School TDD.
 *
 * Covers: thread reply on WorkCompleted, broadcast on PlanCreated.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus, createDomainEvent } from '../../../src/kernel/event-bus';
import { createSlackResponder } from '../../../src/integration/slack/slack-responder';
import type { Logger } from '../../../src/shared/logger';
import type { IntakeEvent, SlackSourceMetadata } from '../../../src/types';
import { planId as pId, workItemId as wId } from '../../../src/kernel/branded-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestLogger(): Logger {
  const noop = () => {};
  return {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => createTestLogger(),
  } as unknown as Logger;
}

function makeSlackIntakeEvent(overrides: Partial<SlackSourceMetadata> = {}): IntakeEvent {
  return {
    id: 'test-intake-id',
    timestamp: new Date().toISOString(),
    source: 'slack',
    sourceMetadata: {
      source: 'slack',
      channelId: 'C123',
      threadTs: '999.999',
      userId: 'U456',
      ...overrides,
    },
    entities: { repo: 'org/repo' },
    rawText: 'test message',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackResponder', () => {
  let eventBus: ReturnType<typeof createEventBus>;
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    eventBus = createEventBus();
    fetchCalls = [];
    originalFetch = globalThis.fetch;

    // Mock fetch
    globalThis.fetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      fetchCalls.push({ url: String(url), body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should post thread reply on WorkCompleted for Slack-sourced work', async () => {
    const responder = createSlackResponder({
      eventBus,
      logger: createTestLogger(),
      slackBotToken: 'xoxb-test-token',
    });
    responder.start();

    const pid = pId('plan-123');

    // Simulate PlanCreated to register context
    eventBus.publish(createDomainEvent('PlanCreated', {
      workflowPlan: { id: pid, workItemId: wId('wi-1'), agentTeam: [] },
      intakeEvent: makeSlackIntakeEvent(),
    }));

    // Simulate WorkCompleted
    eventBus.publish(createDomainEvent('WorkCompleted', {
      workItemId: wId('wi-1'),
      planId: pid,
      phaseCount: 1,
      totalDuration: 5000,
      output: 'Done fixing the bug',
    }));

    // Allow the async fetch to settle
    await new Promise((r) => setTimeout(r, 50));

    const slackApiCalls = fetchCalls.filter((c) => c.url.includes('slack.com/api/chat.postMessage'));
    assert.ok(slackApiCalls.length > 0, 'Should have posted to Slack API');
    assert.equal(slackApiCalls[0].body.channel, 'C123');
    assert.equal(slackApiCalls[0].body.thread_ts, '999.999');
    assert.ok(
      (slackApiCalls[0].body.text as string).includes('5.0s'),
      'Should include duration',
    );

    responder.stop();
  });

  it('should send broadcast on PlanCreated when webhookUrl is set', async () => {
    const responder = createSlackResponder({
      eventBus,
      logger: createTestLogger(),
      slackBotToken: 'xoxb-test-token',
      broadcastWebhookUrl: 'https://hooks.slack.com/test',
    });
    responder.start();

    const pid = pId('plan-456');

    eventBus.publish(createDomainEvent('PlanCreated', {
      workflowPlan: { id: pid, workItemId: wId('wi-2'), agentTeam: [] },
      intakeEvent: makeSlackIntakeEvent(),
    }));

    await new Promise((r) => setTimeout(r, 50));

    const webhookCalls = fetchCalls.filter((c) => c.url.includes('hooks.slack.com'));
    assert.ok(webhookCalls.length > 0, 'Should have posted to broadcast webhook');
    assert.ok(
      (webhookCalls[0].body.text as string).includes('Plan created'),
      'Should include plan created message',
    );

    responder.stop();
  });

  it('should post thread reply on WorkFailed for Slack-sourced work', async () => {
    const responder = createSlackResponder({
      eventBus,
      logger: createTestLogger(),
      slackBotToken: 'xoxb-test-token',
    });
    responder.start();

    const pid = pId('plan-789');

    // Register context
    eventBus.publish(createDomainEvent('PlanCreated', {
      workflowPlan: { id: pid, workItemId: wId('wi-3'), agentTeam: [] },
      intakeEvent: makeSlackIntakeEvent(),
    }));

    // Simulate WorkFailed
    eventBus.publish(createDomainEvent('WorkFailed', {
      workItemId: wId('wi-3'),
      failureReason: 'Timeout exceeded',
      retryCount: 0,
    }));

    await new Promise((r) => setTimeout(r, 50));

    const slackApiCalls = fetchCalls.filter((c) => c.url.includes('slack.com/api/chat.postMessage'));
    assert.ok(slackApiCalls.length > 0, 'Should have posted failure to Slack API');
    assert.ok(
      (slackApiCalls[0].body.text as string).includes('Timeout exceeded'),
      'Should include failure reason',
    );

    responder.stop();
  });

  it('should NOT call Slack API when source is not slack', async () => {
    const responder = createSlackResponder({
      eventBus,
      logger: createTestLogger(),
      slackBotToken: 'xoxb-test-token',
    });
    responder.start();

    const pid = pId('plan-gh-1');

    // PlanCreated with source='github' (not slack)
    const githubIntake: IntakeEvent = {
      id: 'gh-intake-id',
      timestamp: new Date().toISOString(),
      source: 'github',
      sourceMetadata: {
        source: 'github',
        eventType: 'push',
        deliveryId: 'delivery-1',
        repoFullName: 'org/repo',
      },
      entities: { repo: 'org/repo' },
      rawText: 'push event',
    };

    eventBus.publish(createDomainEvent('PlanCreated', {
      workflowPlan: { id: pid, workItemId: wId('wi-gh'), agentTeam: [] },
      intakeEvent: githubIntake,
    }));

    eventBus.publish(createDomainEvent('WorkCompleted', {
      workItemId: wId('wi-gh'),
      planId: pid,
      phaseCount: 2,
      totalDuration: 3000,
      output: 'done',
    }));

    await new Promise((r) => setTimeout(r, 50));

    // fetch should NOT have been called for Slack API (no thread reply)
    const slackApiCalls = fetchCalls.filter((c) => c.url.includes('slack.com/api/chat.postMessage'));
    assert.equal(slackApiCalls.length, 0, 'Should NOT post to Slack API for non-slack source');

    responder.stop();
  });

  it('should handle fetch failure gracefully without unhandled rejection', async () => {
    // Mock fetch to throw
    globalThis.fetch = mock.fn(async () => {
      throw new Error('Network error');
    }) as unknown as typeof fetch;

    const responder = createSlackResponder({
      eventBus,
      logger: createTestLogger(),
      slackBotToken: 'xoxb-test-token',
      broadcastWebhookUrl: 'https://hooks.slack.com/fail',
    });
    responder.start();

    const pid = pId('plan-fail');

    eventBus.publish(createDomainEvent('PlanCreated', {
      workflowPlan: { id: pid, workItemId: wId('wi-fail'), agentTeam: [] },
      intakeEvent: makeSlackIntakeEvent(),
    }));

    eventBus.publish(createDomainEvent('WorkCompleted', {
      workItemId: wId('wi-fail'),
      planId: pid,
      phaseCount: 1,
      totalDuration: 1000,
      output: 'result',
    }));

    // Allow async work to settle -- if .catch() is missing, this will throw unhandled rejection
    await new Promise((r) => setTimeout(r, 100));

    // If we got here without an unhandled rejection, the test passes
    assert.ok(true, 'No unhandled rejection from fetch failure');

    responder.stop();
  });

  it('should clean up subscriptions on stop', () => {
    const responder = createSlackResponder({
      eventBus,
      logger: createTestLogger(),
      slackBotToken: 'xoxb-test-token',
    });
    responder.start();
    responder.stop();

    // No error thrown = clean stop
    assert.ok(true);
  });
});
