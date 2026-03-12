/**
 * Retry Handler.
 *
 * Wraps a PhaseRunner to add retry logic for failed non-skippable phases.
 * On each retry, publishes a PhaseRetried event via the event bus.
 *
 * - Successful or skipped phases pass through without retry.
 * - Failed non-skippable phases are retried up to maxRetries (default 3).
 * - After all retries are exhausted, the final failed result is returned.
 */

import type { EventBus } from '../shared/event-bus';
import { createDomainEvent } from '../shared/event-bus';
import type { PhaseRunner } from './phase-runner';
import type { WorkflowPlan, PlannedPhase, PhaseResult } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryHandlerDeps {
  phaseRunner: PhaseRunner;
  eventBus: EventBus;
  /** Maximum number of retry attempts after the initial failure. Default: 3. */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a RetryHandler that implements the PhaseRunner interface,
 * wrapping an inner PhaseRunner with retry logic.
 */
export function createRetryHandler(deps: RetryHandlerDeps): PhaseRunner {
  const { phaseRunner, eventBus, maxRetries = 3 } = deps;

  return {
    async runPhase(plan: WorkflowPlan, phase: PlannedPhase): Promise<PhaseResult> {
      let result = await phaseRunner.runPhase(plan, phase);

      // Only retry non-skippable phases that failed
      if (result.status !== 'failed' || phase.skippable) {
        return result;
      }

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Publish PhaseRetried event before each retry attempt
        eventBus.publish(
          createDomainEvent('PhaseRetried', {
            phaseId: result.phaseId,
            retryCount: attempt,
            feedback: `Phase ${phase.type} failed, retrying (attempt ${attempt}/${maxRetries})`,
          }),
        );

        result = await phaseRunner.runPhase(plan, phase);

        if (result.status !== 'failed') {
          return result;
        }
      }

      // All retries exhausted, return the final failed result
      return result;
    },
  };
}
