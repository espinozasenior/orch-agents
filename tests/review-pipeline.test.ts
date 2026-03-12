/**
 * TDD: Tests for the Review Pipeline.
 *
 * RED phase: These tests define the contract for consuming WorkCompleted
 * events and producing ReviewCompleted events with a ReviewVerdict.
 *
 * The review pipeline:
 * 1. Subscribes to WorkCompleted
 * 2. Produces ReviewCompleted with a stub ReviewVerdict (always approved)
 * 3. Preserves correlationId from WorkCompleted through to ReviewCompleted
 * 4. Handles multiple WorkCompleted events independently
 * 5. Returns an unsubscribe function for shutdown
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewVerdict } from '../src/types';
import type { ReviewCompletedEvent, WorkCompletedEvent } from '../src/shared/event-types';
import { createEventBus, createDomainEvent } from '../src/shared/event-bus';
import { createLogger } from '../src/shared/logger';
import { startReviewPipeline, type ReviewPipelineDeps } from '../src/review/review-pipeline';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkCompletedEvent(
  overrides: Partial<WorkCompletedEvent['payload']> = {},
  correlationId = 'review-corr-001',
): WorkCompletedEvent {
  return createDomainEvent('WorkCompleted', {
    workItemId: 'work-review-001',
    planId: 'plan-review-001',
    phaseCount: 2,
    totalDuration: 1500,
    ...overrides,
  }, correlationId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Review Pipeline', () => {
  let eventBus: ReturnType<typeof createEventBus>;
  let unsub: (() => void) | undefined;

  afterEach(() => {
    unsub?.();
    unsub = undefined;
    eventBus?.removeAllListeners();
  });

  describe('WorkCompleted -> ReviewCompleted', () => {
    it('subscribes to WorkCompleted and publishes ReviewCompleted', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      unsub = startReviewPipeline({ eventBus, logger });

      const reviewEvents: ReviewCompletedEvent[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        reviewEvents.push(evt);
      });

      eventBus.publish(makeWorkCompletedEvent());

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(reviewEvents.length, 1, 'Should publish exactly one ReviewCompleted');
      assert.equal(reviewEvents[0].type, 'ReviewCompleted');
    });

    it('ReviewCompleted contains a ReviewVerdict with approved=true (stub)', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      unsub = startReviewPipeline({ eventBus, logger });

      const verdicts: ReviewVerdict[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        verdicts.push(evt.payload.reviewVerdict);
      });

      eventBus.publish(makeWorkCompletedEvent());

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(verdicts.length, 1);
      const verdict = verdicts[0];
      assert.equal(verdict.status, 'pass', 'Stub should always pass');
      assert.equal(verdict.codeReviewApproval, true, 'Stub should always approve');
      assert.equal(verdict.securityScore, 100, 'Stub should give perfect security score');
      assert.equal(verdict.testCoveragePercent, 100, 'Stub should give 100% coverage');
      assert.ok(Array.isArray(verdict.findings), 'findings should be an array');
      assert.equal(verdict.findings.length, 0, 'Stub should have no findings');
    });

    it('ReviewVerdict.phaseResultId references the workItemId', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      unsub = startReviewPipeline({ eventBus, logger });

      const verdicts: ReviewVerdict[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        verdicts.push(evt.payload.reviewVerdict);
      });

      eventBus.publish(makeWorkCompletedEvent({ workItemId: 'work-xyz-99' }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(verdicts[0].phaseResultId, 'work-xyz-99');
    });
  });

  describe('Correlation ID preservation', () => {
    it('preserves correlationId from WorkCompleted to ReviewCompleted', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      unsub = startReviewPipeline({ eventBus, logger });

      const correlationIds: string[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        correlationIds.push(evt.correlationId);
      });

      eventBus.publish(makeWorkCompletedEvent({}, 'preserve-me-123'));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(correlationIds.length, 1);
      assert.equal(correlationIds[0], 'preserve-me-123');
    });
  });

  describe('Multiple events', () => {
    it('handles multiple WorkCompleted events independently', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      unsub = startReviewPipeline({ eventBus, logger });

      const reviews: ReviewCompletedEvent[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        reviews.push(evt);
      });

      eventBus.publish(makeWorkCompletedEvent({ workItemId: 'work-A', planId: 'plan-A' }, 'corr-A'));
      eventBus.publish(makeWorkCompletedEvent({ workItemId: 'work-B', planId: 'plan-B' }, 'corr-B'));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(reviews.length, 2, 'Should produce two ReviewCompleted events');

      const workItemIds = reviews.map((r) => r.payload.reviewVerdict.phaseResultId);
      assert.ok(workItemIds.includes('work-A'));
      assert.ok(workItemIds.includes('work-B'));

      const corrIds = reviews.map((r) => r.correlationId);
      assert.ok(corrIds.includes('corr-A'));
      assert.ok(corrIds.includes('corr-B'));
    });
  });

  describe('Shutdown', () => {
    it('shutdown unsubscribes from events', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      unsub = startReviewPipeline({ eventBus, logger });
      unsub();

      const reviews: unknown[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        reviews.push(evt);
      });

      eventBus.publish(makeWorkCompletedEvent());

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(reviews.length, 0, 'No ReviewCompleted after shutdown');

      // Prevent double unsub in afterEach
      unsub = undefined;
    });
  });

  describe('Error handling', () => {
    it('handles malformed event data without crashing', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      unsub = startReviewPipeline({ eventBus, logger });

      const reviews: ReviewCompletedEvent[] = [];
      const failures: unknown[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        reviews.push(evt);
      });
      eventBus.subscribe('WorkFailed', (evt) => {
        failures.push(evt);
      });

      // Publish a malformed WorkCompleted (missing required fields)
      const malformed = createDomainEvent('WorkCompleted', {
        workItemId: '',
        planId: '',
        phaseCount: 0,
        totalDuration: 0,
      });
      eventBus.publish(malformed);

      await new Promise((r) => setTimeout(r, 50));

      // Should either handle gracefully with a WorkFailed or still produce
      // a ReviewCompleted (stub). The key assertion: no unhandled crash.
      assert.equal(reviews.length + failures.length, 1,
        'Should produce either ReviewCompleted or WorkFailed');
    });
  });
});
