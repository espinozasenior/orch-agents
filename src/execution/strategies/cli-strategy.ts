/**
 * CLI Strategy — real agent execution via Layer 2 components (Phase 3).
 *
 * Delegates to SwarmManager, AgentOrchestrator, TaskDelegator, ArtifactCollector.
 * Lazy-initializes the swarm on first call, reuses on subsequent calls.
 */

import { randomUUID } from 'node:crypto';
import type { PlannedPhase, PhaseResult, WorkflowPlan } from '../../types';
import type { Logger } from '../../shared/logger';
import type { SwarmHandle } from '../swarm-manager';
import type { SpawnedAgent } from '../agent-orchestrator';
import type { TaskResultRef } from '../artifact-collector';
import type { PhaseStrategy, StrategyDeps } from './phase-strategy';
import { computeUtilization, computeModelCost, makeFailedResult, resolveStatus } from './strategy-helpers';

/**
 * Create a CLI strategy instance with a cached swarm handle.
 */
export function createCliStrategy(): PhaseStrategy & { getCachedSwarmHandle(): SwarmHandle | undefined; clearSwarmHandle(): void } {
  let cachedSwarmHandle: SwarmHandle | undefined;

  return {
    name: 'cli',

    canHandle(deps: StrategyDeps): boolean {
      return !!(deps.swarmManager && deps.agentOrchestrator && deps.taskDelegator && deps.artifactCollector);
    },

    getCachedSwarmHandle(): SwarmHandle | undefined {
      return cachedSwarmHandle;
    },

    clearSwarmHandle(): void {
      cachedSwarmHandle = undefined;
    },

    async run(
      plan: WorkflowPlan,
      phase: PlannedPhase,
      deps: StrategyDeps,
      logger?: Logger,
    ): Promise<PhaseResult> {
      const phaseId = randomUUID();
      const startTime = Date.now();

      logger?.info('Running phase with real agents', { planId: plan.id, phase: phase.type });

      let spawnedAgents: SpawnedAgent[] = [];

      try {
        // 1. Lazy-init swarm on first call
        if (!cachedSwarmHandle) {
          cachedSwarmHandle = await deps.swarmManager!.initSwarm(plan);
          logger?.info('Swarm initialized', { swarmId: cachedSwarmHandle.swarmId });
        }

        // 2. Spawn agents for this phase
        spawnedAgents = await deps.agentOrchestrator!.spawnAgents(
          cachedSwarmHandle.swarmId,
          phase,
          plan.agentTeam,
        );

        // 3. Create and assign tasks
        const agentRefs = spawnedAgents.map((a) => ({ agentId: a.agentId, role: a.role }));
        const delegatedTasks = await deps.taskDelegator!.createAndAssign(plan, phase, agentRefs);

        // 4. Wait for agents to complete (also terminates them on success now)
        await deps.agentOrchestrator!.waitForAgents(spawnedAgents, deps.phaseTimeoutMs);

        // 5. Collect task results
        const taskResults = await deps.taskDelegator!.collectResults(delegatedTasks);

        // 6. Build TaskResultRef[] for artifact collector
        const taskResultRefs: TaskResultRef[] = taskResults.map((tr) => ({
          taskId: tr.taskId,
          agentId: tr.agentId,
          status: tr.status,
          output: tr.output,
        }));

        // 7. Collect artifacts
        const artifacts = deps.artifactCollector!.collect(phaseId, phase, taskResultRefs);

        // 8. Store checkpoint
        await deps.artifactCollector!.storeCheckpoint(plan.id, phaseId, artifacts);

        // 9. Run gate checker
        const gateResult = await deps.gateChecker(plan.id, phase);
        const duration = Date.now() - startTime;
        const status = resolveStatus(gateResult.passed, phase.skippable);

        return {
          phaseId,
          planId: plan.id,
          phaseType: phase.type,
          status,
          artifacts,
          metrics: {
            duration,
            agentUtilization: computeUtilization(phase, plan),
            modelCost: computeModelCost(phase, plan),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error('Phase execution failed', { planId: plan.id, phase: phase.type, error: message });

        // Ensure agents are cleaned up on error too
        if (spawnedAgents.length > 0) {
          await deps.agentOrchestrator!.terminateAgents(spawnedAgents).catch((cleanupErr) => {
            logger?.warn('Failed to cleanup agents after error', {
              error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          });
        }

        return makeFailedResult(phaseId, plan, phase, startTime);
      }
    },
  };
}
