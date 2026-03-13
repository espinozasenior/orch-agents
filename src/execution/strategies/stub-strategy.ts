/**
 * Stub Strategy — simulates agent work when no real deps are provided.
 *
 * Backward-compatible fallback: runs gate check only, returns empty artifacts.
 */

import { randomUUID } from 'node:crypto';
import type { PlannedPhase, PhaseResult, WorkflowPlan } from '../../types';
import type { Logger } from '../../shared/logger';
import type { PhaseStrategy, StrategyDeps } from './phase-strategy';
import { computeUtilization, computeModelCost, resolveStatus } from './strategy-helpers';

/**
 * Create a stub strategy instance.
 */
export function createStubStrategy(): PhaseStrategy {
  return {
    name: 'stub',

    canHandle(): boolean {
      // Stub is the catch-all fallback — always returns true.
      // It is placed last in the strategy list.
      return true;
    },

    async run(
      plan: WorkflowPlan,
      phase: PlannedPhase,
      deps: StrategyDeps,
      _logger?: Logger,
    ): Promise<PhaseResult> {
      const phaseId = randomUUID();
      const startTime = Date.now();

      const gateResult = await deps.gateChecker(plan.id, phase);
      const duration = Date.now() - startTime;
      const status = resolveStatus(gateResult.passed, phase.skippable);

      return {
        phaseId,
        planId: plan.id,
        phaseType: phase.type,
        status,
        artifacts: [],
        metrics: {
          duration,
          agentUtilization: computeUtilization(phase, plan),
          modelCost: computeModelCost(phase, plan),
        },
      };
    },
  };
}
