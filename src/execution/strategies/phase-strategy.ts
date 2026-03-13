/**
 * PhaseStrategy interface — Strategy pattern for phase execution modes.
 *
 * Each strategy encapsulates one execution mode (stub, CLI, task-tool, interactive).
 * The PhaseRunner selects the first matching strategy via canHandle().
 */

import type { PlannedPhase, PhaseResult, WorkflowPlan, IntakeEvent } from '../../types';
import type { Logger } from '../../shared/logger';
import type { GateChecker } from '../phase-runner';
import type { SwarmManager } from '../swarm-manager';
import type { AgentOrchestrator } from '../agent-orchestrator';
import type { TaskDelegator } from '../task-delegator';
import type { ArtifactCollector } from '../artifact-collector';
import type { TaskExecutor } from '../task-executor';
import type { InteractiveTaskExecutor } from '../interactive-executor';
import type { WorktreeManager } from '../worktree-manager';
import type { ArtifactApplier } from '../artifact-applier';
import type { FixItLoop } from '../fix-it-loop';
import type { ReviewGate } from '../../review/review-gate';
import type { GitHubClient } from '../../integration/github-client';
import type { EventBus } from '../../shared/event-bus';

/**
 * Dependencies available to all strategies.
 */
export interface StrategyDeps {
  gateChecker: GateChecker;
  swarmManager?: SwarmManager;
  agentOrchestrator?: AgentOrchestrator;
  taskDelegator?: TaskDelegator;
  artifactCollector?: ArtifactCollector;
  taskExecutor?: TaskExecutor;
  interactiveExecutor?: InteractiveTaskExecutor;
  worktreeManager?: WorktreeManager;
  artifactApplier?: ArtifactApplier;
  fixItLoop?: FixItLoop;
  reviewGate?: ReviewGate;
  githubClient?: GitHubClient;
  eventBus?: EventBus;
  logger?: Logger;
  phaseTimeoutMs: number;
}

/**
 * Strategy interface for executing a phase.
 */
export interface PhaseStrategy {
  /** Human-readable name for logging/debugging. */
  readonly name: string;

  /** Return true if this strategy can handle the given phase + deps combination. */
  canHandle(deps: StrategyDeps, phase: PlannedPhase, intakeEvent?: IntakeEvent): boolean;

  /** Execute the phase. Called only when canHandle() returned true. */
  run(
    plan: WorkflowPlan,
    phase: PlannedPhase,
    deps: StrategyDeps,
    logger?: Logger,
    intakeEvent?: IntakeEvent,
  ): Promise<PhaseResult>;
}
