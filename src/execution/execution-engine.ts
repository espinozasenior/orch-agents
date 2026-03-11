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
import { createWorkTracker } from './work-tracker';

// ---------------------------------------------------------------------------
// Execution Engine
// ---------------------------------------------------------------------------

export interface ExecutionEngineDeps {
  eventBus: EventBus;
  logger: Logger;
  phaseRunner: PhaseRunner;
}

/**
 * Start the execution engine: subscribe to PlanCreated,
 * run phases, publish PhaseStarted/PhaseCompleted/WorkFailed.
 * Returns an unsubscribe function for cleanup.
 */
export function startExecutionEngine(deps: ExecutionEngineDeps): () => void {
  const { eventBus, logger, phaseRunner } = deps;
  const tracker = createWorkTracker();

  return eventBus.subscribe('PlanCreated', async (event) => {
    const plan = event.payload.workflowPlan;
    const correlationId = event.correlationId;

    logger.info('Executing plan', {
      planId: plan.id,
      workItemId: plan.workItemId,
      phases: plan.phases.length,
      methodology: plan.methodology,
    });

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

        logger.debug('Phase started', { planId: plan.id, phase: phase.type });

        // Run the phase
        const result = await phaseRunner.runPhase(plan, phase);

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
        });

        // If non-skippable phase failed, stop execution
        if (result.status === 'failed') {
          const reason = `Phase ${phase.type} failed gate check`;
          tracker.fail(plan.id, reason);

          eventBus.publish(
            createDomainEvent('WorkFailed', {
              workItemId: plan.workItemId,
              failureReason: reason,
              retryCount: 0,
            }, correlationId),
          );

          logger.warn('Execution stopped: phase failed', {
            planId: plan.id,
            phase: phase.type,
          });
          return;
        }
      }

      // All phases completed successfully
      tracker.complete(plan.id);
      logger.info('Plan execution completed', { planId: plan.id });

    } catch (err) {
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
