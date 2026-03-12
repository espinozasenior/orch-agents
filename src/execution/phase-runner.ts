/**
 * Phase Runner.
 *
 * Executes a single SPARC phase within a workflow plan.
 * Uses a pluggable GateChecker to verify quality gates after execution.
 *
 * Supports two modes:
 * - Stub mode (no real deps): simulates agent work, runs gate check only.
 * - Real mode (with SwarmManager, AgentOrchestrator, etc.): delegates to
 *   actual agents via the Layer 2 execution components.
 */

import { randomUUID } from 'node:crypto';
import type { PlannedPhase, PhaseResult, WorkflowPlan } from '../types';
import { TIER_COSTS, DEFAULT_AGENT_COST } from '../shared/constants';
import type { Logger } from '../shared/logger';
import type { SwarmManager, SwarmHandle } from './swarm-manager';
import type { AgentOrchestrator, SpawnedAgent } from './agent-orchestrator';
import type { TaskDelegator } from './task-delegator';
import type { ArtifactCollector, TaskResultRef } from './artifact-collector';

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
  runPhase(plan: WorkflowPlan, phase: PlannedPhase): Promise<PhaseResult>;
  dispose?(): Promise<void>;
}

export interface PhaseRunnerDeps {
  gateChecker: GateChecker;
  // Phase 3: real agent execution (optional for backward compat)
  swarmManager?: SwarmManager;
  agentOrchestrator?: AgentOrchestrator;
  taskDelegator?: TaskDelegator;
  artifactCollector?: ArtifactCollector;
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
 * Create a PhaseRunner that executes a phase and checks its gate.
 *
 * When real deps (swarmManager, agentOrchestrator, taskDelegator,
 * artifactCollector) are provided, delegates to real agents.
 * Otherwise, falls back to stub behavior.
 */
export function createPhaseRunner(deps: PhaseRunnerDeps): PhaseRunner {
  const {
    gateChecker,
    swarmManager,
    agentOrchestrator,
    taskDelegator,
    artifactCollector,
    logger,
    phaseTimeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
  } = deps;

  const hasRealDeps = !!(swarmManager && agentOrchestrator && taskDelegator && artifactCollector);

  // Cached swarm handle for lazy init
  let cachedSwarmHandle: SwarmHandle | undefined;

  // -------------------------------------------------------------------------
  // Stub execution (backward compat)
  // -------------------------------------------------------------------------

  async function runStub(plan: WorkflowPlan, phase: PlannedPhase): Promise<PhaseResult> {
    const phaseId = randomUUID();
    const startTime = Date.now();

    const gateResult = await gateChecker(plan.id, phase);
    const duration = Date.now() - startTime;

    let status: 'completed' | 'failed' | 'skipped';
    if (gateResult.passed) {
      status = 'completed';
    } else if (phase.skippable) {
      status = 'skipped';
    } else {
      status = 'failed';
    }

    const agentsInPhase = phase.agents.length;
    const totalAgents = plan.agentTeam.length;
    const agentUtilization = totalAgents > 0 ? agentsInPhase / totalAgents : 0;

    let modelCost = 0;
    for (const agentRole of phase.agents) {
      const agent = plan.agentTeam.find((a) => a.role === agentRole || a.type === agentRole);
      modelCost += TIER_COSTS[agent?.tier ?? 0] ?? DEFAULT_AGENT_COST;
    }

    return {
      phaseId,
      planId: plan.id,
      phaseType: phase.type,
      status,
      artifacts: [],
      metrics: {
        duration,
        agentUtilization: Math.round(agentUtilization * 100) / 100,
        modelCost: Math.round(modelCost * 10000) / 10000,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Real execution (Phase 3)
  // -------------------------------------------------------------------------

  async function runReal(plan: WorkflowPlan, phase: PlannedPhase): Promise<PhaseResult> {
    const phaseId = randomUUID();
    const startTime = Date.now();

    logger?.info('Running phase with real agents', { planId: plan.id, phase: phase.type });

    try {
      // 1. Lazy-init swarm on first call
      if (!cachedSwarmHandle) {
        cachedSwarmHandle = await swarmManager!.initSwarm(plan);
        logger?.info('Swarm initialized', { swarmId: cachedSwarmHandle.swarmId });
      }

      // 2. Spawn agents for this phase
      const spawnedAgents: SpawnedAgent[] = await agentOrchestrator!.spawnAgents(
        cachedSwarmHandle.swarmId,
        phase,
        plan.agentTeam,
      );

      // 3. Create and assign tasks
      const agentRefs = spawnedAgents.map((a) => ({ agentId: a.agentId, role: a.role }));
      const delegatedTasks = await taskDelegator!.createAndAssign(plan, phase, agentRefs);

      // 4. Wait for agents to complete
      await agentOrchestrator!.waitForAgents(spawnedAgents, phaseTimeoutMs);

      // 5. Collect task results
      const taskResults = await taskDelegator!.collectResults(delegatedTasks);

      // 6. Build TaskResultRef[] for artifact collector
      const taskResultRefs: TaskResultRef[] = taskResults.map((tr) => ({
        taskId: tr.taskId,
        agentId: tr.agentId,
        status: tr.status,
        output: tr.output,
      }));

      // 7. Collect artifacts
      const artifacts = artifactCollector!.collect(phaseId, phase, taskResultRefs);

      // 8. Store checkpoint
      await artifactCollector!.storeCheckpoint(plan.id, phaseId, artifacts);

      // 9. Run gate checker
      const gateResult = await gateChecker(plan.id, phase);
      const duration = Date.now() - startTime;

      // 10. Determine status
      let status: 'completed' | 'failed' | 'skipped';
      if (gateResult.passed) {
        status = 'completed';
      } else if (phase.skippable) {
        status = 'skipped';
      } else {
        status = 'failed';
      }

      // Compute metrics
      const agentsInPhase = phase.agents.length;
      const totalAgents = plan.agentTeam.length;
      const agentUtilization = totalAgents > 0 ? agentsInPhase / totalAgents : 0;

      let modelCost = 0;
      for (const agentRole of phase.agents) {
        const agent = plan.agentTeam.find((a) => a.role === agentRole || a.type === agentRole);
        modelCost += TIER_COSTS[agent?.tier ?? 0] ?? DEFAULT_AGENT_COST;
      }

      return {
        phaseId,
        planId: plan.id,
        phaseType: phase.type,
        status,
        artifacts,
        metrics: {
          duration,
          agentUtilization: Math.round(agentUtilization * 100) / 100,
          modelCost: Math.round(modelCost * 10000) / 10000,
        },
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      logger?.error('Phase execution failed', { planId: plan.id, phase: phase.type, error: message });

      return {
        phaseId,
        planId: plan.id,
        phaseType: phase.type,
        status: 'failed',
        artifacts: [],
        metrics: {
          duration,
          agentUtilization: 0,
          modelCost: 0,
        },
      };
    }
  }

  // -------------------------------------------------------------------------
  // Dispose — shut down cached swarm
  // -------------------------------------------------------------------------

  async function dispose(): Promise<void> {
    if (cachedSwarmHandle && swarmManager) {
      logger?.info('Disposing phase runner, shutting down swarm', {
        swarmId: cachedSwarmHandle.swarmId,
      });
      await swarmManager.shutdownSwarm(cachedSwarmHandle.swarmId);
      cachedSwarmHandle = undefined;
    }
  }

  return {
    runPhase: hasRealDeps ? runReal : runStub,
    dispose,
  };
}
