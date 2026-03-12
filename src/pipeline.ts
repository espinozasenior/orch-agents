/**
 * Pipeline wiring module.
 *
 * Connects the processing engines (Triage, Planning, Execution, Review) to
 * the shared event bus, forming the full event-sourced pipeline:
 *
 *   IntakeCompleted -> Triage -> WorkTriaged -> Planning -> PlanCreated -> Execution -> WorkCompleted -> Review -> ReviewCompleted
 *
 * Each engine subscribes to its input event and publishes its output event.
 * The pipeline module owns startup/shutdown lifecycle for all engines.
 */

import type { EventBus } from './shared/event-bus';
import type { Logger } from './shared/logger';
import { startTriageEngine } from './triage/triage-engine';
import { startPlanningEngine } from './planning/planning-engine';
import { startExecutionEngine } from './execution/execution-engine';
import { createPhaseRunner, type GateChecker } from './execution/phase-runner';
import { startReviewPipeline } from './review/review-pipeline';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  eventBus: EventBus;
  logger: Logger;
  /** Optional custom gate checker. Defaults to a pass-through that always passes. */
  gateChecker?: GateChecker;
}

export interface PipelineHandle {
  /** Unsubscribe all engines from the event bus. */
  shutdown(): void;
}

// ---------------------------------------------------------------------------
// Default gate checker (pass-through for Phase 3 in-process execution)
// ---------------------------------------------------------------------------

const passThroughGateChecker: GateChecker = async () => ({ passed: true });

// ---------------------------------------------------------------------------
// Pipeline startup
// ---------------------------------------------------------------------------

/**
 * Start the full processing pipeline by wiring all engines to the event bus.
 *
 * Returns a handle with a `shutdown()` method that unsubscribes all engines,
 * allowing clean teardown in tests and graceful shutdown in production.
 */
export function startPipeline(deps: PipelineDeps): PipelineHandle {
  const { eventBus, logger, gateChecker } = deps;

  const pipelineLogger = logger.child ? logger.child({ module: 'pipeline' }) : logger;

  pipelineLogger.info('Starting pipeline engines');

  // Wire triage engine: IntakeCompleted -> WorkTriaged
  const unsubTriage = startTriageEngine({ eventBus, logger });

  // Wire planning engine: WorkTriaged -> PlanCreated
  const unsubPlanning = startPlanningEngine({ eventBus, logger });

  // Wire execution engine: PlanCreated -> WorkCompleted / WorkFailed
  const phaseRunner = createPhaseRunner({
    gateChecker: gateChecker ?? passThroughGateChecker,
  });
  const unsubExecution = startExecutionEngine({ eventBus, logger, phaseRunner });

  // Wire review pipeline: WorkCompleted -> ReviewCompleted
  const unsubReview = startReviewPipeline({ eventBus, logger });

  pipelineLogger.info('Pipeline engines started');

  return {
    shutdown(): void {
      pipelineLogger.info('Shutting down pipeline engines');
      unsubTriage();
      unsubPlanning();
      unsubExecution();
      unsubReview();
      pipelineLogger.info('Pipeline engines stopped');
    },
  };
}
