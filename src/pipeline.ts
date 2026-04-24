/**
 * Pipeline wiring module.
 *
 * Connects the processing engines to the shared event bus:
 *
 *   IntakeCompleted -> Execution -> WorkCompleted -> Review -> ReviewCompleted
 *
 * The triage engine runs independently (IntakeCompleted -> WorkTriaged)
 * for observability, but execution no longer depends on it.
 *
 * The planning layer has been removed. Template and agent resolution
 * happens inside the execution engine using WORKFLOW.md directly.
 */

import type { EventBus } from './kernel/event-bus';
import type { Logger } from './shared/logger';
import { startTriageEngine } from './triage/triage-engine';
import { startExecutionEngine } from './execution/orchestrator/execution-engine';
import { startReviewPipeline } from './review/review-pipeline';
import type { ReviewGate } from './review/review-gate';
import type { CoordinatorDispatcher } from './execution/coordinator-dispatcher';
import type { WorkflowConfig } from './config';
import type { GitHubClient } from './integration/github-client';
import type { LinearClient } from './integration/linear/linear-client';
import type { SkillResolver } from './intake/skill-resolver';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  eventBus: EventBus;
  logger: Logger;
  reviewGate?: ReviewGate;
  /**
   * CC-aligned coordinator dispatch — used by both IntakeCompleted and
   * AgentPrompted handlers in the main-thread execution engine
   * (Option C step 2, PR A).
   */
  localAgentTask: CoordinatorDispatcher;
  workflowConfig: WorkflowConfig;
  githubClient?: GitHubClient;
  linearClient?: LinearClient;
  linearExecutionMode?: 'generic' | 'symphony';
  /** P20 — optional skill resolver override (defaults to filesystem-backed). */
  skillResolver?: SkillResolver;
  /** P20 — repository root used to resolve relative skill paths. */
  repoRoot?: string;
}

export interface PipelineHandle {
  /** Unsubscribe all engines from the event bus. */
  shutdown(): void;
}

// ---------------------------------------------------------------------------
// Pipeline startup
// ---------------------------------------------------------------------------

/**
 * Start the processing pipeline by wiring all engines to the event bus.
 *
 * Returns a handle with a `shutdown()` method that unsubscribes all engines,
 * allowing clean teardown in tests and graceful shutdown in production.
 */
export async function startPipeline(deps: PipelineDeps): Promise<PipelineHandle> {
  const { eventBus, logger } = deps;

  const pipelineLogger = logger.child ? logger.child({ module: 'pipeline' }) : logger;

  pipelineLogger.info('Starting pipeline engines');

  // Wire triage engine: IntakeCompleted -> WorkTriaged (observability only)
  const unsubTriage = startTriageEngine({ eventBus, logger });

  // Wire execution engine: IntakeCompleted -> WorkCompleted / WorkFailed
  const unsubExecution = startExecutionEngine({
    eventBus,
    logger,
    localAgentTask: deps.localAgentTask,
    workflowConfig: deps.workflowConfig,
    githubClient: deps.githubClient,
    linearClient: deps.linearClient,
    linearExecutionMode: deps.linearExecutionMode,
    skillResolver: deps.skillResolver,
    repoRoot: deps.repoRoot,
  });

  // Wire review pipeline: WorkCompleted -> ReviewCompleted
  const unsubReview = startReviewPipeline({
    eventBus,
    logger,
    reviewGate: deps.reviewGate,
  });

  pipelineLogger.info('Pipeline engines started');

  return {
    shutdown(): void {
      pipelineLogger.info('Shutting down pipeline engines');
      unsubTriage();
      unsubExecution();
      unsubReview();
      pipelineLogger.info('Pipeline engines stopped');
    },
  };
}
