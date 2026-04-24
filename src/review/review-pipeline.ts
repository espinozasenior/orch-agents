/**
 * Review Pipeline.
 *
 * Subscribes to WorkCompleted events and produces ReviewCompleted events
 * with a ReviewVerdict.
 *
 * When a ReviewGate is provided, delegates to it for actual review
 * (security scans, test coverage, code review). When absent, falls back
 * to the stub behavior that always auto-approves.
 *
 * Bounded context: Review
 * Input event:  WorkCompleted
 * Output event: ReviewCompleted
 */

import type { ReviewVerdict } from '../types';
import type { EventBus } from '../kernel/event-bus';
import type { Logger } from '../shared/logger';
import type { WorkCompletedEvent } from '../kernel/event-types';
import { createDomainEvent } from '../kernel/event-bus';
import { ReviewError } from '../kernel/errors';
import type { ReviewGate } from './review-gate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewPipelineDeps {
  eventBus: EventBus;
  logger: Logger;
  /** Optional ReviewGate for real review. When absent, uses stub (auto-approve). */
  reviewGate?: ReviewGate;
}

// ---------------------------------------------------------------------------
// Stub verdict builder
// ---------------------------------------------------------------------------

/**
 * Build a stub ReviewVerdict that always approves.
 * Used when no ReviewGate is provided (backward compatible).
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
 *
 * When a ReviewGate is provided in deps, uses it for actual review.
 * When absent, preserves the stub behavior (auto-approve).
 */
export function startReviewPipeline(deps: ReviewPipelineDeps): () => void {
  const { eventBus, logger, reviewGate } = deps;

  return eventBus.subscribe('WorkCompleted', async (event: WorkCompletedEvent) => {
    const { workItemId, planId } = event.payload;
    const correlationId = event.correlationId;

    logger.info('Reviewing completed work', { workItemId, planId });

    try {
      let verdict: ReviewVerdict;
      let reviewMode: string;

      // M1: Only use ReviewGate when sufficient context is available.
      // The WorkCompleted event may carry diff/worktreePath in its payload.
      const eventDiff = (event.payload as Record<string, unknown>).diff as string | undefined;
      const eventWorktreePath = (event.payload as Record<string, unknown>).worktreePath as string | undefined;
      const eventArtifacts = (event.payload as Record<string, unknown>).artifacts as unknown[] | undefined;
      const hasContext = !!(eventDiff || eventWorktreePath);

      if (reviewGate && hasContext) {
        // Real review via ReviewGate with sufficient context
        reviewMode = 'review-gate';
        verdict = await reviewGate.review({
          planId,
          workItemId,
          commitSha: (event.payload as Record<string, unknown>).commitSha as string ?? 'HEAD',
          branch: (event.payload as Record<string, unknown>).branch as string ?? 'main',
          worktreePath: eventWorktreePath ?? '',
          diff: eventDiff ?? '',
          artifacts: (eventArtifacts ?? []) as import('../types').Artifact[],
          context: {
            commitSha: (event.payload as Record<string, unknown>).commitSha as string ?? 'HEAD',
            attempt: 1,
          },
        });
      } else if (reviewGate && !hasContext) {
        // ReviewGate present but context insufficient — fall back to stub with warning
        reviewMode = 'stub';
        logger.warn('ReviewGate available but insufficient context in WorkCompleted event — falling back to stub review', {
          workItemId,
          planId,
        });
        verdict = buildStubVerdict(workItemId);
      } else {
        // Stub review — auto-approve
        reviewMode = 'stub';
        verdict = buildStubVerdict(workItemId);
      }

      logger.info('Review complete', {
        workItemId,
        planId,
        status: verdict.status,
        approved: verdict.codeReviewApproval,
        reviewMode,
        feedback: verdict.feedback,
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
          planId,
          failureReason: reviewErr.message,
          retryCount: 0,
        }, correlationId),
      );
    }
  });
}
