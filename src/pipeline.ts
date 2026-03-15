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
import type { CliClient } from './execution/cli-client';
import type { TaskExecutor } from './execution/task-executor';
import type { AgentTracker } from './execution/agent-tracker';
import type { CancellationController } from './execution/cancellation-controller';
import { createSwarmManager } from './execution/swarm-manager';
import { createAgentOrchestrator } from './execution/agent-orchestrator';
import { createTaskDelegator } from './execution/task-delegator';
import { createArtifactCollector } from './execution/artifact-collector';
import type { InteractiveTaskExecutor } from './execution/interactive-executor';
import type { WorktreeManager } from './execution/worktree-manager';
import type { ArtifactApplier } from './execution/artifact-applier';
import type { FixItLoop } from './execution/fix-it-loop';
import type { ReviewGate } from './review/review-gate';
import type { GitHubClient } from './integration/github-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  eventBus: EventBus;
  logger: Logger;
  /** Optional custom gate checker. Defaults to a pass-through that always passes. */
  gateChecker?: GateChecker;
  /** Optional MCP client for real agent execution. When provided, enables real swarm/agent mode. */
  cliClient?: CliClient;
  /** Optional TaskExecutor for task-tool agent execution. When provided with intakeEvent, agents do real work. */
  taskExecutor?: TaskExecutor;
  /** Phase 5: interactive execution components (optional) */
  interactiveExecutor?: InteractiveTaskExecutor;
  worktreeManager?: WorktreeManager;
  artifactApplier?: ArtifactApplier;
  fixItLoop?: FixItLoop;
  reviewGate?: ReviewGate;
  githubClient?: GitHubClient;
  /** Dorothy streaming layer (optional) */
  agentTracker?: AgentTracker;
  cancellationController?: CancellationController;
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
  const { eventBus, logger, gateChecker, cliClient, taskExecutor } = deps;

  const pipelineLogger = logger.child ? logger.child({ module: 'pipeline' }) : logger;

  pipelineLogger.info('Starting pipeline engines');

  // Wire triage engine: IntakeCompleted -> WorkTriaged
  const unsubTriage = startTriageEngine({ eventBus, logger });

  // Wire planning engine: WorkTriaged -> PlanCreated
  const unsubPlanning = startPlanningEngine({ eventBus, logger });

  // Wire execution engine: PlanCreated -> WorkCompleted / WorkFailed
  const phaseRunnerDeps: Parameters<typeof createPhaseRunner>[0] = {
    gateChecker: gateChecker ?? passThroughGateChecker,
  };

  // When cliClient is provided, wire up real execution components
  if (cliClient) {
    const execLogger = logger.child ? logger.child({ module: 'execution' }) : logger;
    phaseRunnerDeps.swarmManager = createSwarmManager({ logger: execLogger, cliClient });
    phaseRunnerDeps.agentOrchestrator = createAgentOrchestrator({ logger: execLogger, cliClient });
    phaseRunnerDeps.taskDelegator = createTaskDelegator({ logger: execLogger, cliClient });
    phaseRunnerDeps.artifactCollector = createArtifactCollector({ logger: execLogger, cliClient });
    phaseRunnerDeps.logger = execLogger;
  }

  // When taskExecutor is provided, enable task-tool mode
  if (taskExecutor) {
    phaseRunnerDeps.taskExecutor = taskExecutor;
    const execLogger = phaseRunnerDeps.logger ?? (logger.child ? logger.child({ module: 'execution' }) : logger);
    phaseRunnerDeps.logger = execLogger;
  }

  // When interactive execution deps are provided, wire them through
  if (deps.interactiveExecutor) {
    phaseRunnerDeps.interactiveExecutor = deps.interactiveExecutor;
  }
  if (deps.worktreeManager) {
    phaseRunnerDeps.worktreeManager = deps.worktreeManager;
  }
  if (deps.artifactApplier) {
    phaseRunnerDeps.artifactApplier = deps.artifactApplier;
  }
  if (deps.fixItLoop) {
    phaseRunnerDeps.fixItLoop = deps.fixItLoop;
  }
  if (deps.reviewGate) {
    phaseRunnerDeps.reviewGate = deps.reviewGate;
  }
  if (deps.githubClient) {
    phaseRunnerDeps.githubClient = deps.githubClient;
  }

  // Thread eventBus through for domain event emission (Phase 6)
  phaseRunnerDeps.eventBus = eventBus;

  const phaseRunner = createPhaseRunner(phaseRunnerDeps);
  const unsubExecution = startExecutionEngine({ eventBus, logger, phaseRunner });

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
      unsubPlanning();
      unsubExecution();
      unsubReview();
      pipelineLogger.info('Pipeline engines stopped');
    },
  };
}
