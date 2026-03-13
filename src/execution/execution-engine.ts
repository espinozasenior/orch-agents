/**
 * Execution Engine.
 *
 * Subscribes to PlanCreated events and orchestrates SPARC phase execution:
 * 1. For each phase in the plan, publishes PhaseStarted
 * 2. Runs the phase via PhaseRunner
 * 3. Publishes PhaseCompleted with the result
 * 4. On non-skippable failure, publishes WorkFailed and stops
 * 5. Tracks state via WorkTracker
 */

import type { EventBus } from '../shared/event-bus';
import type { Logger } from '../shared/logger';
import { createDomainEvent } from '../shared/event-bus';
import { ExecutionError } from '../shared/errors';
import type { PhaseRunner } from './phase-runner';
import { createRetryHandler } from './retry-handler';
import { createWorkTracker } from './work-tracker';

// ---------------------------------------------------------------------------
// Execution Engine
// ---------------------------------------------------------------------------

export interface ExecutionEngineDeps {
  eventBus: EventBus;
  logger: Logger;
  phaseRunner: PhaseRunner;
  /** Maximum retries per failed non-skippable phase. Default: 3. */
  maxRetries?: number;
}

/**
 * Start the execution engine: subscribe to PlanCreated,
 * run phases, publish PhaseStarted/PhaseCompleted/WorkFailed.
 * Returns an unsubscribe function for cleanup.
 */
export function startExecutionEngine(deps: ExecutionEngineDeps): () => void {
  const { eventBus, logger, phaseRunner, maxRetries } = deps;
  const retryRunner = createRetryHandler({ phaseRunner, eventBus, maxRetries });
  const tracker = createWorkTracker();

  return eventBus.subscribe('PlanCreated', async (event) => {
    const plan = event.payload.workflowPlan;
    const intakeEvent = event.payload.intakeEvent;
    const correlationId = event.correlationId;

    logger.info('Executing plan', {
      planId: plan.id,
      workItemId: plan.workItemId,
      phases: plan.phases.length,
      methodology: plan.methodology,
      correlationId,
    });

    // Guard against duplicate PlanCreated events
    if (tracker.getState(plan.id)) {
      logger.warn('Duplicate PlanCreated ignored', { planId: plan.id });
      return;
    }

    // Track this work item
    tracker.start(plan.id, plan.workItemId);

    try {
      for (const phase of plan.phases) {
        // Publish PhaseStarted
        eventBus.publish(
          createDomainEvent('PhaseStarted', {
            planId: plan.id,
            phaseType: phase.type,
            agents: phase.agents,
          }, correlationId),
        );

        logger.debug('Phase started', { planId: plan.id, phase: phase.type, correlationId });

        // Run the phase (with retry logic for non-skippable failures)
        const result = await retryRunner.runPhase(plan, phase, intakeEvent);

        // Record in tracker
        tracker.recordPhaseResult(plan.id, result);

        // Publish PhaseCompleted
        eventBus.publish(
          createDomainEvent('PhaseCompleted', {
            phaseResult: result,
          }, correlationId),
        );

        logger.info('Phase completed', {
          planId: plan.id,
          phase: phase.type,
          status: result.status,
          duration: result.metrics.duration,
          correlationId,
        });

        // If non-skippable phase failed, stop execution
        if (result.status === 'failed') {
          const reason = `Phase ${phase.type} failed gate check`;
          tracker.fail(plan.id, reason);

          // Clean up swarm resources on failure
          await phaseRunner.dispose?.();

          eventBus.publish(
            createDomainEvent('WorkFailed', {
              workItemId: plan.workItemId,
              failureReason: reason,
              retryCount: maxRetries ?? 3,
            }, correlationId),
          );

          logger.warn('Execution stopped: phase failed after retries', {
            planId: plan.id,
            phase: phase.type,
          });
          return;
        }
      }

      // All phases completed successfully
      tracker.complete(plan.id);
      const state = tracker.getState(plan.id);
      logger.info('Plan execution completed', { planId: plan.id, correlationId });

      // Clean up swarm resources
      await phaseRunner.dispose?.();

      // Publish WorkCompleted so downstream consumers can react
      eventBus.publish(
        createDomainEvent('WorkCompleted', {
          workItemId: plan.workItemId,
          planId: plan.id,
          phaseCount: plan.phases.length,
          totalDuration: state?.totalDuration ?? 0,
        }, correlationId),
      );

    } catch (err) {
      // Clean up swarm resources on error
      await phaseRunner.dispose?.().catch(() => {});

      const reason = err instanceof Error ? err.message : String(err);
      tracker.fail(plan.id, reason);

      const execErr = new ExecutionError(
        `Execution failed for plan ${plan.id}: ${reason}`,
        { cause: err },
      );
      logger.error('Execution error', { planId: plan.id, error: execErr.message });

      eventBus.publish(
        createDomainEvent('WorkFailed', {
          workItemId: plan.workItemId,
          failureReason: reason,
          retryCount: 0,
        }, correlationId),
      );
    }
  });
}
