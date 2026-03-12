/**
 * TDD: End-to-end pipeline integration test.
 *
 * Verifies the full event-sourced pipeline:
 * IntakeCompleted -> Triage -> WorkTriaged -> Planning -> PlanCreated -> Execution -> WorkCompleted -> Review -> ReviewCompleted
 *
 * All engines are wired to a shared event bus via the pipeline module.
 * Uses event-driven waits (not setTimeout) for reliable CI.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent, ReviewVerdict } from '../../src/types';
import { createEventBus, createDomainEvent } from '../../src/shared/event-bus';
import type { EventBus } from '../../src/shared/event-bus';
import type { DomainEventType } from '../../src/shared/event-types';
import { createLogger } from '../../src/shared/logger';
import { setUrgencyRules, resetUrgencyRules } from '../../src/triage/triage-engine';
import { startPipeline, type PipelineHandle } from '../../src/pipeline';

// ---------------------------------------------------------------------------
// Test urgency rules (avoid filesystem dependency on config/urgency-rules.json)
// ---------------------------------------------------------------------------

const TEST_URGENCY_RULES = {
  priorityWeights: {
    severity: 0.35,
    impact: 0.25,
    skipTriage: 1.0,
    labelBoost: 0.2,
    recency: 0.2,
  },
  severityScores: {
    critical: 1.0,
    high: 0.75,
    medium: 0.5,
    low: 0.25,
  },
  impactScores: {
    'system-wide': 1.0,
    'cross-cutting': 0.75,
    module: 0.5,
    isolated: 0.25,
  },
  labelBoosts: {
    security: 0.3,
    bug: 0.2,
    enhancement: 0.1,
    refactor: 0.05,
  },
  priorityThresholds: {
    'P0-immediate': 0.8,
    'P1-high': 0.6,
    'P2-standard': 0.35,
    'P3-backlog': 0,
  },
  effortMapping: {
    trivial: { maxComplexity: 15, maxFiles: 1 },
    small: { maxComplexity: 30, maxFiles: 3 },
    medium: { maxComplexity: 50, maxFiles: 8 },
    large: { maxComplexity: 75, maxFiles: 20 },
    epic: { maxComplexity: 100, maxFiles: 100 },
  },
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeIntakeEvent(overrides: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    id: 'intake-e2e-001',
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: { skipTriage: true, phases: ['refinement', 'completion'] },
    intent: 'validate-branch',
    entities: {
      repo: 'test-org/test-repo',
      branch: 'feature/e2e',
      severity: 'medium',
      files: ['src/index.ts'],
      labels: [],
    },
    ...overrides,
  };
}

/** Wait for a specific event type, with a timeout for safety. */
function waitForEvent<T extends DomainEventType>(
  eventBus: EventBus,
  eventType: T,
  timeoutMs = 5000,
): Promise<{ type: T; id: string; correlationId: string; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for ${eventType} after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsub = eventBus.subscribe(eventType, (evt: unknown) => {
      clearTimeout(timer);
      unsub();
      resolve(evt as { type: T; id: string; correlationId: string; payload: unknown });
    });
  });
}

/** Collect N events of a given type, with a timeout. */
function collectEvents<T extends DomainEventType>(
  eventBus: EventBus,
  eventType: T,
  count: number,
  timeoutMs = 5000,
): Promise<{ type: T; id: string; correlationId: string; payload: unknown }[]> {
  return new Promise((resolve, reject) => {
    const collected: { type: T; id: string; correlationId: string; payload: unknown }[] = [];
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out collecting ${count} ${eventType} events (got ${collected.length}) after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsub = eventBus.subscribe(eventType, (evt: unknown) => {
      collected.push(evt as { type: T; id: string; correlationId: string; payload: unknown });
      if (collected.length >= count) {
        clearTimeout(timer);
        unsub();
        resolve(collected);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pipeline E2E', () => {
  let handle: PipelineHandle | undefined;

  afterEach(() => {
    handle?.shutdown();
    handle = undefined;
    resetUrgencyRules();
  });

  it('IntakeCompleted flows through triage, planning, execution to WorkCompleted and ReviewCompleted', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });
    setUrgencyRules(TEST_URGENCY_RULES);

    handle = startPipeline({ eventBus, logger });

    // Set up event-driven waits before publishing
    const reviewPromise = waitForEvent(eventBus, 'ReviewCompleted');
    const workCompletedPromise = waitForEvent(eventBus, 'WorkCompleted');
    const triagedPromise = waitForEvent(eventBus, 'WorkTriaged');
    const planPromise = waitForEvent(eventBus, 'PlanCreated');

    // Act
    const intakeEvent = makeIntakeEvent();
    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'e2e-corr-001'));

    // Wait for final event in the chain
    const [triaged, plan, workCompleted, review] = await Promise.all([
      triagedPromise, planPromise, workCompletedPromise, reviewPromise,
    ]);

    // Assert full chain completed
    assert.ok(triaged, 'Should produce a WorkTriaged event');
    assert.ok(plan, 'Should produce a PlanCreated event');

    const wcPayload = workCompleted.payload as { workItemId: string; phaseCount: number };
    assert.equal(wcPayload.workItemId, 'intake-e2e-001');
    assert.ok(wcPayload.phaseCount > 0, 'Should have executed at least one phase');

    const rcPayload = review.payload as { reviewVerdict: ReviewVerdict };
    assert.equal(rcPayload.reviewVerdict.status, 'pass', 'Stub review should pass');
    assert.equal(rcPayload.reviewVerdict.codeReviewApproval, true);
    assert.equal(rcPayload.reviewVerdict.phaseResultId, 'intake-e2e-001');
  });

  it('preserves correlationId through the full pipeline', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });
    setUrgencyRules(TEST_URGENCY_RULES);

    handle = startPipeline({ eventBus, logger });

    const reviewPromise = waitForEvent(eventBus, 'ReviewCompleted');

    const correlationIds: string[] = [];
    eventBus.subscribe('WorkTriaged', (evt) => correlationIds.push(evt.correlationId));
    eventBus.subscribe('PlanCreated', (evt) => correlationIds.push(evt.correlationId));
    eventBus.subscribe('WorkCompleted', (evt) => correlationIds.push(evt.correlationId));

    const intakeEvent = makeIntakeEvent({ id: 'intake-corr-001' });
    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }, 'pipeline-corr-001'));

    const review = await reviewPromise;
    correlationIds.push(review.correlationId);

    assert.equal(correlationIds.length, 4);
    for (const cid of correlationIds) {
      assert.equal(cid, 'pipeline-corr-001', 'All events should share the same correlationId');
    }
  });

  it('handles complex events through the full pipeline', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });
    setUrgencyRules(TEST_URGENCY_RULES);

    handle = startPipeline({ eventBus, logger });

    // Wait for either WorkCompleted or WorkFailed
    const resultPromise = Promise.race([
      waitForEvent(eventBus, 'WorkCompleted').then((e) => ({ type: 'completed' as const, event: e })),
      waitForEvent(eventBus, 'WorkFailed').then((e) => ({ type: 'failed' as const, event: e })),
    ]);

    const intakeEvent = makeIntakeEvent({
      id: 'intake-complex-001',
      sourceMetadata: { skipTriage: false },
      intent: 'incident-response',
      entities: {
        severity: 'critical',
        files: Array.from({ length: 25 }, (_, i) => `dir${i}/file.ts`),
        labels: ['security', 'system-wide'],
      },
    });

    eventBus.publish(createDomainEvent('IntakeCompleted', { intakeEvent }));

    const result = await resultPromise;
    assert.ok(
      result.type === 'completed' || result.type === 'failed',
      'Should produce either WorkCompleted or WorkFailed',
    );
  });

  it('handles multiple IntakeCompleted events concurrently', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });
    setUrgencyRules(TEST_URGENCY_RULES);

    handle = startPipeline({ eventBus, logger });

    // Wait for 2 WorkCompleted events
    const completedPromise = collectEvents(eventBus, 'WorkCompleted', 2);

    eventBus.publish(createDomainEvent('IntakeCompleted', {
      intakeEvent: makeIntakeEvent({ id: 'concurrent-001' }),
    }));
    eventBus.publish(createDomainEvent('IntakeCompleted', {
      intakeEvent: makeIntakeEvent({ id: 'concurrent-002' }),
    }));

    const completed = await completedPromise;
    const ids = completed.map((e) => (e.payload as { workItemId: string }).workItemId);

    assert.equal(ids.length, 2, 'Both work items should complete');
    assert.ok(ids.includes('concurrent-001'));
    assert.ok(ids.includes('concurrent-002'));
  });

  it('shutdown stops all engines (no events processed after)', async () => {
    const eventBus = createEventBus();
    const logger = createLogger({ level: 'error' });
    setUrgencyRules(TEST_URGENCY_RULES);

    handle = startPipeline({ eventBus, logger });
    handle.shutdown();

    const triagedEvents: unknown[] = [];
    eventBus.subscribe('WorkTriaged', (evt) => triagedEvents.push(evt));

    eventBus.publish(createDomainEvent('IntakeCompleted', {
      intakeEvent: makeIntakeEvent(),
    }));

    // Short wait — just enough for any async handler that might still be queued
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(triagedEvents.length, 0, 'No events should be processed after shutdown');

    handle = undefined;
  });
});
