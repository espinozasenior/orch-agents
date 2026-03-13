/**
 * Phase Runner — thin orchestrator that delegates to strategy implementations.
 *
 * Executes a single SPARC phase within a workflow plan.
 * Uses the Strategy pattern to select execution mode:
 *   1. Interactive — worktree-based agent execution (Phase 5)
 *   2. Task-tool — prompt-based agent execution (Phase 4)
 *   3. CLI — real agent lifecycle via Layer 2 (Phase 3)
 *   4. Stub — simulated execution (fallback)
 *
 * The first strategy whose canHandle() returns true is selected.
 */

import type { PlannedPhase, PhaseResult, WorkflowPlan, IntakeEvent } from '../types';
import type { Logger } from '../shared/logger';
import type { SwarmManager } from './swarm-manager';
import type { AgentOrchestrator } from './agent-orchestrator';
import type { TaskDelegator } from './task-delegator';
import type { ArtifactCollector } from './artifact-collector';
import type { TaskExecutor } from './task-executor';
import type { WorktreeManager } from './worktree-manager';
import type { ArtifactApplier } from './artifact-applier';
import type { InteractiveTaskExecutor } from './interactive-executor';
import type { FixItLoop } from './fix-it-loop';
import type { ReviewGate } from '../review/review-gate';
import type { GitHubClient } from '../integration/github-client';
import type { EventBus } from '../shared/event-bus';

import type { PhaseStrategy, StrategyDeps } from './strategies/phase-strategy';
import { createInteractiveStrategy } from './strategies/interactive-strategy';
import { createTaskToolStrategy } from './strategies/task-tool-strategy';
import { createCliStrategy } from './strategies/cli-strategy';
import { createStubStrategy } from './strategies/stub-strategy';

// ---------------------------------------------------------------------------
// Gate checker interface (mock-friendly)
// ---------------------------------------------------------------------------

export interface GateCheckResult {
  passed: boolean;
  reason?: string;
}

export type GateChecker = (
  planId: string,
  phase: PlannedPhase,
) => Promise<GateCheckResult>;

// ---------------------------------------------------------------------------
// Phase runner interface and factory
// ---------------------------------------------------------------------------

export interface PhaseRunner {
  runPhase(plan: WorkflowPlan, phase: PlannedPhase, intakeEvent?: IntakeEvent): Promise<PhaseResult>;
  dispose?(): Promise<void>;
}

export interface PhaseRunnerDeps {
  gateChecker: GateChecker;
  // Phase 3: real agent execution (optional for backward compat)
  swarmManager?: SwarmManager;
  agentOrchestrator?: AgentOrchestrator;
  taskDelegator?: TaskDelegator;
  artifactCollector?: ArtifactCollector;
  // Phase 4: task-tool execution (optional, takes priority when intakeEvent available)
  taskExecutor?: TaskExecutor;
  // Phase 5: interactive execution (optional, takes priority for refinement phases)
  interactiveExecutor?: InteractiveTaskExecutor;
  worktreeManager?: WorktreeManager;
  artifactApplier?: ArtifactApplier;
  fixItLoop?: FixItLoop;
  reviewGate?: ReviewGate;
  githubClient?: GitHubClient;
  // Phase 6: domain event emission
  eventBus?: EventBus;
  logger?: Logger;
  phaseTimeoutMs?: number; // default 300000 (5 min)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PHASE_TIMEOUT_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PhaseRunner that executes a phase by selecting the first
 * matching strategy and delegating to it.
 *
 * Strategy priority (first match wins):
 *   1. interactive — taskExecutor + intakeEvent + refinement + interactive deps
 *   2. task-tool   — taskExecutor + intakeEvent
 *   3. cli         — swarmManager + agentOrchestrator + taskDelegator + artifactCollector
 *   4. stub        — always matches (fallback)
 */
export function createPhaseRunner(deps: PhaseRunnerDeps): PhaseRunner {
  const {
    gateChecker,
    swarmManager,
    agentOrchestrator,
    taskDelegator,
    artifactCollector,
    taskExecutor,
    interactiveExecutor,
    worktreeManager,
    artifactApplier,
    fixItLoop,
    reviewGate,
    githubClient,
    eventBus,
    logger,
    phaseTimeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
  } = deps;

  // Build strategy deps from PhaseRunnerDeps
  const strategyDeps: StrategyDeps = {
    gateChecker,
    swarmManager,
    agentOrchestrator,
    taskDelegator,
    artifactCollector,
    taskExecutor,
    interactiveExecutor,
    worktreeManager,
    artifactApplier,
    fixItLoop,
    reviewGate,
    githubClient,
    eventBus,
    logger,
    phaseTimeoutMs,
  };

  // Create strategies in priority order
  const cliStrategy = createCliStrategy();
  const strategies: PhaseStrategy[] = [
    createInteractiveStrategy(),
    createTaskToolStrategy(),
    cliStrategy,
    createStubStrategy(),
  ];

  // -------------------------------------------------------------------------
  // Dispose — shut down cached swarm from CLI strategy
  // -------------------------------------------------------------------------

  async function dispose(): Promise<void> {
    const swarmHandle = cliStrategy.getCachedSwarmHandle();
    if (swarmHandle && swarmManager) {
      logger?.info('Disposing phase runner, shutting down swarm', {
        swarmId: swarmHandle.swarmId,
      });
      await swarmManager.shutdownSwarm(swarmHandle.swarmId);
      cliStrategy.clearSwarmHandle();
    }
  }

  return {
    runPhase(plan: WorkflowPlan, phase: PlannedPhase, intakeEvent?: IntakeEvent): Promise<PhaseResult> {
      for (const strategy of strategies) {
        if (strategy.canHandle(strategyDeps, phase, intakeEvent)) {
          return strategy.run(plan, phase, strategyDeps, logger, intakeEvent);
        }
      }
      // Should never reach here because stub always matches
      return strategies[strategies.length - 1].run(plan, phase, strategyDeps, logger, intakeEvent);
    },
    dispose,
  };
}
