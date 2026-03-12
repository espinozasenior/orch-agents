/**
 * Review Pipeline.
 *
 * Subscribes to WorkCompleted events and produces ReviewCompleted events
 * with a ReviewVerdict. This is a STUB implementation that always approves
 * -- real review logic (security scans, test coverage, code review) will
 * be wired in later phases.
 *
 * Bounded context: Review
 * Input event:  WorkCompleted
 * Output event: ReviewCompleted
 */

import type { ReviewVerdict } from '../types';
import type { EventBus } from '../shared/event-bus';
import type { Logger } from '../shared/logger';
import type { WorkCompletedEvent } from '../shared/event-types';
import { createDomainEvent } from '../shared/event-bus';
import { ReviewError } from '../shared/errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewPipelineDeps {
  eventBus: EventBus;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Stub verdict builder
// ---------------------------------------------------------------------------

/**
 * Build a stub ReviewVerdict that always approves.
 * Real implementation will aggregate security scans, test coverage,
 * and code review signals.
 */
function buildStubVerdict(workItemId: string): ReviewVerdict {
  return {
    phaseResultId: workItemId,
    status: 'pass',
    findings: [],
    securityScore: 100,
    testCoveragePercent: 100,
    codeReviewApproval: true,
    feedback: 'Stub review: auto-approved',
  };
}

// ---------------------------------------------------------------------------
// Event bus wiring
// ---------------------------------------------------------------------------

/**
 * Start the review pipeline: subscribe to WorkCompleted, publish ReviewCompleted.
 * Returns an unsubscribe function for cleanup.
 */
export function startReviewPipeline(deps: ReviewPipelineDeps): () => void {
  const { eventBus, logger } = deps;

  return eventBus.subscribe('WorkCompleted', (event: WorkCompletedEvent) => {
    const { workItemId, planId } = event.payload;
    const correlationId = event.correlationId;

    logger.info('Reviewing completed work', { workItemId, planId });

    try {
      const verdict = buildStubVerdict(workItemId);

      logger.info('Review complete', {
        workItemId,
        planId,
        status: verdict.status,
        approved: verdict.codeReviewApproval,
      });

      eventBus.publish(
        createDomainEvent('ReviewCompleted', {
          reviewVerdict: verdict,
        }, correlationId),
      );
    } catch (err) {
      const reviewErr = new ReviewError(
        `Failed to review work item ${workItemId}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
      logger.error('Review failed', { workItemId, error: reviewErr.message });

      eventBus.publish(
        createDomainEvent('WorkFailed', {
          workItemId,
          failureReason: reviewErr.message,
          retryCount: 0,
        }, correlationId),
      );
    }
  });
}
