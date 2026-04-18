/**
 * Slack Notifier Tests.
 *
 * Verifies that the Slack notifier correctly subscribes to domain events,
 * correlates PlanCreated with WorkCompleted, and sends formatted messages
 * to the configured webhook URL.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus, createDomainEvent } from '../../src/kernel/event-bus';
import { startSlackNotifier } from '../../src/notification/slack-notifier';
import type { EventBus } from '../../src/kernel/event-bus';
import type { Logger } from '../../src/shared/logger';
import type { PlanId, WorkItemId } from '../../src/kernel/branded-types';
import type { IntakeEvent, WorkflowPlan } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: mock.fn(noop),
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

function makePlanId(id: string): PlanId {
  return id as PlanId;
}

function makeWorkItemId(id: string): WorkItemId {
  return id as WorkItemId;
}

function makeIntakeEvent(overrides?: Partial<IntakeEvent>): IntakeEvent {
  return {
    id: 'intake-1',
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: {
      source: 'github' as const,
      eventType: 'pull_request',
      action: 'opened',
      deliveryId: 'del-1',
      skillPath: 'skills/pr-review/SKILL.md',
    },
    entities: {
      repo: 'acme/widgets',
    },
    ...overrides,
  };
}

function makePlan(id: string): WorkflowPlan {
  return {
    id: makePlanId(id),
    workItemId: makeWorkItemId(`work-${id}`),
    agentTeam: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackNotifier', () => {
  let eventBus: EventBus;
  let logger: Logger;
  let cleanup: () => void;
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    eventBus = createEventBus();
    logger = createMockLogger();

    originalFetch = globalThis.fetch;
    fetchMock = mock.fn(() =>
      Promise.resolve(new Response('ok', { status: 200 })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup?.();
    globalThis.fetch = originalFetch;
  });

  it('sends success message on WorkCompleted with correlated PlanCreated', async () => {
    cleanup = startSlackNotifier({
      eventBus,
      logger,
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
    });

    const planId = makePlanId('plan-1');

    // Publish PlanCreated to build correlation
    eventBus.publish(createDomainEvent('PlanCreated', {
      workflowPlan: makePlan('plan-1'),
      intakeEvent: makeIntakeEvent(),
    }));

    // Publish WorkCompleted
    eventBus.publish(createDomainEvent('WorkCompleted', {
      workItemId: makeWorkItemId('work-plan-1'),
      planId,
      phaseCount: 3,
      totalDuration: 12500,
    }));

    // fetch is fire-and-forget, give microtask queue a tick
    await new Promise(r => setTimeout(r, 10));

    assert.equal(fetchMock.mock.calls.length, 1);
    const [url, opts] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, 'https://hooks.slack.com/services/T00/B00/xxx');
    assert.equal(opts.method, 'POST');

    const body = JSON.parse(opts.body);
    assert.ok(body.text.includes('Agent completed'));
    assert.ok(body.text.includes('acme/widgets'));
    assert.ok(body.text.includes('12.5s'));
    assert.ok(body.text.includes('Phases: 3'));
    assert.ok(body.text.includes('pr-review'));
  });

  it('sends failure message on WorkFailed', async () => {
    cleanup = startSlackNotifier({
      eventBus,
      logger,
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
    });

    eventBus.publish(createDomainEvent('WorkFailed', {
      workItemId: makeWorkItemId('work-42'),
      failureReason: 'Agent timed out',
      retryCount: 0,
    }));

    await new Promise(r => setTimeout(r, 10));

    assert.equal(fetchMock.mock.calls.length, 1);
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.ok(body.text.includes('Agent failed'));
    assert.ok(body.text.includes('work-42'));
    assert.ok(body.text.includes('Agent timed out'));
  });

  it('skips WorkCompleted when no PlanCreated correlation exists', async () => {
    cleanup = startSlackNotifier({
      eventBus,
      logger,
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
    });

    // Publish WorkCompleted without a preceding PlanCreated
    eventBus.publish(createDomainEvent('WorkCompleted', {
      workItemId: makeWorkItemId('work-orphan'),
      planId: makePlanId('plan-orphan'),
      phaseCount: 1,
      totalDuration: 1000,
    }));

    await new Promise(r => setTimeout(r, 10));

    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('logs warning on fetch failure', async () => {
    globalThis.fetch = mock.fn(() =>
      Promise.reject(new Error('Network error')),
    ) as unknown as typeof fetch;

    cleanup = startSlackNotifier({
      eventBus,
      logger,
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
    });

    eventBus.publish(createDomainEvent('WorkFailed', {
      workItemId: makeWorkItemId('work-err'),
      failureReason: 'boom',
      retryCount: 0,
    }));

    await new Promise(r => setTimeout(r, 50));

    const warnCalls = (logger.warn as ReturnType<typeof mock.fn>).mock.calls;
    const networkWarning = warnCalls.find(
      (c: { arguments: unknown[] }) => {
        const msg = c.arguments[0];
        return typeof msg === 'string' && msg.includes('Slack webhook request failed');
      },
    );
    assert.ok(networkWarning, 'Expected a warning log for fetch failure');
  });

  it('cleanup unsubscribes and clears context map', async () => {
    cleanup = startSlackNotifier({
      eventBus,
      logger,
      webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx',
    });

    // Build correlation
    eventBus.publish(createDomainEvent('PlanCreated', {
      workflowPlan: makePlan('plan-cleanup'),
      intakeEvent: makeIntakeEvent(),
    }));

    // Call cleanup
    cleanup();

    // Now publish WorkCompleted -- should NOT trigger fetch
    eventBus.publish(createDomainEvent('WorkCompleted', {
      workItemId: makeWorkItemId('work-plan-cleanup'),
      planId: makePlanId('plan-cleanup'),
      phaseCount: 1,
      totalDuration: 500,
    }));

    await new Promise(r => setTimeout(r, 10));

    assert.equal(fetchMock.mock.calls.length, 0);
  });
});
