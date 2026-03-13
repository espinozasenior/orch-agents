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
  overrides: Partial<WorkCompletedEvent['payload']> & Record<string, unknown> = {},
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

/** Make a WorkCompleted event that carries review context (diff, worktreePath). */
function makeWorkCompletedWithContext(
  overrides: Partial<WorkCompletedEvent['payload']> & Record<string, unknown> = {},
  correlationId = 'review-corr-001',
): WorkCompletedEvent {
  return createDomainEvent('WorkCompleted', {
    workItemId: 'work-review-001',
    planId: 'plan-review-001',
    phaseCount: 2,
    totalDuration: 1500,
    diff: 'diff --git a/file.ts\n+line',
    worktreePath: '/tmp/orch-agents/plan-001',
    ...overrides,
  } as WorkCompletedEvent['payload'], correlationId);
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

  describe('Stub mode logging disclosure', () => {
    it('logs reviewMode "stub" in the "Review complete" log line', async () => {
      eventBus = createEventBus();
      const logMessages: { msg: string; ctx?: Record<string, unknown> }[] = [];
      const spyLogger = {
        trace: () => {},
        debug: () => {},
        info: (msg: string, ctx?: unknown) => logMessages.push({ msg, ctx: ctx as Record<string, unknown> }),
        warn: () => {},
        error: () => {},
        fatal: () => {},
        child: () => spyLogger,
      };

      unsub = startReviewPipeline({ eventBus, logger: spyLogger as ReturnType<typeof createLogger> });

      eventBus.publish(makeWorkCompletedEvent());

      await new Promise((r) => setTimeout(r, 50));

      const reviewLog = logMessages.find((l) => l.msg === 'Review complete');
      assert.ok(reviewLog, 'Should log "Review complete"');
      assert.equal(reviewLog!.ctx?.reviewMode, 'stub', 'Should disclose reviewMode as "stub"');
    });

    it('includes feedback in the "Review complete" log line', async () => {
      eventBus = createEventBus();
      const logMessages: { msg: string; ctx?: Record<string, unknown> }[] = [];
      const spyLogger = {
        trace: () => {},
        debug: () => {},
        info: (msg: string, ctx?: unknown) => logMessages.push({ msg, ctx: ctx as Record<string, unknown> }),
        warn: () => {},
        error: () => {},
        fatal: () => {},
        child: () => spyLogger,
      };

      unsub = startReviewPipeline({ eventBus, logger: spyLogger as ReturnType<typeof createLogger> });

      eventBus.publish(makeWorkCompletedEvent());

      await new Promise((r) => setTimeout(r, 50));

      const reviewLog = logMessages.find((l) => l.msg === 'Review complete');
      assert.ok(reviewLog, 'Should log "Review complete"');
      assert.ok(reviewLog!.ctx?.feedback, 'Should include feedback in log');
      assert.equal(reviewLog!.ctx?.feedback, 'Stub review: auto-approved');
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

  // -------------------------------------------------------------------------
  // ReviewGate integration (Phase 6)
  // -------------------------------------------------------------------------

  describe('ReviewGate integration', () => {
    it('uses ReviewGate for review when provided', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const mockReviewGate = {
        review: async () => ({
          phaseResultId: 'work-gate-001',
          status: 'pass' as const,
          findings: [],
          securityScore: 95,
          testCoveragePercent: 88,
          codeReviewApproval: true,
          feedback: 'Real review: all checks passed',
        }),
      };

      unsub = startReviewPipeline({ eventBus, logger, reviewGate: mockReviewGate });

      const verdicts: ReviewVerdict[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        verdicts.push(evt.payload.reviewVerdict);
      });

      eventBus.publish(makeWorkCompletedWithContext({ workItemId: 'work-gate-001' }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(verdicts.length, 1);
      assert.equal(verdicts[0].status, 'pass');
      assert.equal(verdicts[0].feedback, 'Real review: all checks passed');
      assert.equal(verdicts[0].securityScore, 95, 'Should use ReviewGate score, not stub');
      assert.equal(verdicts[0].testCoveragePercent, 88, 'Should use ReviewGate coverage, not stub');
    });

    it('uses ReviewGate verdict even when it fails', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const mockReviewGate = {
        review: async () => ({
          phaseResultId: 'work-fail-001',
          status: 'fail' as const,
          findings: [{ id: 'f1', severity: 'error' as const, category: 'test', message: 'Tests failed' }],
          securityScore: 40,
          testCoveragePercent: 20,
          codeReviewApproval: false,
          feedback: 'Tests are failing',
        }),
      };

      unsub = startReviewPipeline({ eventBus, logger, reviewGate: mockReviewGate });

      const verdicts: ReviewVerdict[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        verdicts.push(evt.payload.reviewVerdict);
      });

      eventBus.publish(makeWorkCompletedWithContext({ workItemId: 'work-fail-001' }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(verdicts.length, 1);
      assert.equal(verdicts[0].status, 'fail', 'Should propagate fail verdict');
      assert.equal(verdicts[0].codeReviewApproval, false);
      assert.equal(verdicts[0].findings.length, 1);
    });

    it('logs reviewMode "review-gate" when ReviewGate is used', async () => {
      eventBus = createEventBus();
      const logMessages: { msg: string; ctx?: Record<string, unknown> }[] = [];
      const spyLogger = {
        trace: () => {},
        debug: () => {},
        info: (msg: string, ctx?: unknown) => logMessages.push({ msg, ctx: ctx as Record<string, unknown> }),
        warn: () => {},
        error: () => {},
        fatal: () => {},
        child: () => spyLogger,
      };

      const mockReviewGate = {
        review: async () => ({
          phaseResultId: 'x',
          status: 'pass' as const,
          findings: [],
          securityScore: 100,
          testCoveragePercent: 100,
          codeReviewApproval: true,
          feedback: 'OK',
        }),
      };

      unsub = startReviewPipeline({
        eventBus,
        logger: spyLogger as ReturnType<typeof createLogger>,
        reviewGate: mockReviewGate,
      });

      eventBus.publish(makeWorkCompletedWithContext());

      await new Promise((r) => setTimeout(r, 50));

      const reviewLog = logMessages.find((l) => l.msg === 'Review complete');
      assert.ok(reviewLog, 'Should log "Review complete"');
      assert.equal(reviewLog!.ctx?.reviewMode, 'review-gate', 'Should disclose reviewMode as "review-gate"');
    });

    it('emits WorkFailed when ReviewGate throws an error', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      const mockReviewGate = {
        review: async () => { throw new Error('ReviewGate crash'); },
      };

      unsub = startReviewPipeline({ eventBus, logger, reviewGate: mockReviewGate });

      const failures: unknown[] = [];
      eventBus.subscribe('WorkFailed', (evt) => {
        failures.push(evt);
      });

      eventBus.publish(makeWorkCompletedWithContext({ workItemId: 'work-crash-001' }));

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(failures.length, 1, 'Should emit WorkFailed when ReviewGate throws');
    });

    it('preserves stub behavior when reviewGate is undefined', async () => {
      eventBus = createEventBus();
      const logger = createLogger({ level: 'error' });

      unsub = startReviewPipeline({ eventBus, logger, reviewGate: undefined });

      const verdicts: ReviewVerdict[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        verdicts.push(evt.payload.reviewVerdict);
      });

      eventBus.publish(makeWorkCompletedEvent());

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(verdicts.length, 1);
      assert.equal(verdicts[0].status, 'pass', 'Stub should auto-approve');
      assert.equal(verdicts[0].feedback, 'Stub review: auto-approved');
    });
  });

  describe('ReviewGate with insufficient context (M1)', () => {
    it('skips ReviewGate and falls back to stub when diff and worktreePath are empty', async () => {
      eventBus = createEventBus();
      const logMessages: { msg: string; ctx?: Record<string, unknown> }[] = [];
      const spyLogger = {
        trace: () => {},
        debug: () => {},
        info: (msg: string, ctx?: unknown) => logMessages.push({ msg, ctx: ctx as Record<string, unknown> }),
        warn: (msg: string, ctx?: unknown) => logMessages.push({ msg, ctx: ctx as Record<string, unknown> }),
        error: () => {},
        fatal: () => {},
        child: () => spyLogger,
      };

      let reviewGateCalled = false;
      const mockReviewGate = {
        review: async () => {
          reviewGateCalled = true;
          return {
            phaseResultId: 'work-noctx',
            status: 'pass' as const,
            findings: [],
            securityScore: 100,
            testCoveragePercent: 100,
            codeReviewApproval: true,
            feedback: 'OK',
          };
        },
      };

      unsub = startReviewPipeline({
        eventBus,
        logger: spyLogger as ReturnType<typeof createLogger>,
        reviewGate: mockReviewGate,
      });

      const verdicts: ReviewVerdict[] = [];
      eventBus.subscribe('ReviewCompleted', (evt) => {
        verdicts.push(evt.payload.reviewVerdict);
      });

      // WorkCompleted with no diff/worktreePath context
      eventBus.publish(makeWorkCompletedEvent());

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(verdicts.length, 1);
      // ReviewGate should NOT have been called since context is insufficient
      assert.equal(reviewGateCalled, false, 'ReviewGate should not be called with empty context');
      // Should fall back to stub
      assert.equal(verdicts[0].status, 'pass');
      assert.equal(verdicts[0].feedback, 'Stub review: auto-approved');

      // Should have logged a warning
      const warnLog = logMessages.find((l) => l.msg.includes('insufficient context'));
      assert.ok(warnLog, 'Should warn about insufficient context');
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
