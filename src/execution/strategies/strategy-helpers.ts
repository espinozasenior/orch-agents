/**
 * Shared helpers used by all PhaseRunner strategies.
 *
 * Extracted from phase-runner.ts to reduce coupling and file size.
 */

import type { PlannedPhase, PhaseResult, WorkflowPlan } from '../../types';
import { TIER_COSTS, DEFAULT_AGENT_COST } from '../../shared/constants';

/**
 * Compute agent utilization: fraction of team used by a phase.
 */
export function computeUtilization(phase: PlannedPhase, plan: WorkflowPlan): number {
  const totalAgents = plan.agentTeam.length;
  const used = phase.agents.length;
  return totalAgents > 0 ? Math.round((used / totalAgents) * 100) / 100 : 0;
}

/**
 * Compute estimated model cost for a phase based on agent tiers.
 */
export function computeModelCost(phase: PlannedPhase, plan: WorkflowPlan): number {
  let cost = 0;
  for (const agentRole of phase.agents) {
    const agent = plan.agentTeam.find((a) => a.role === agentRole || a.type === agentRole);
    cost += TIER_COSTS[agent?.tier ?? 0] ?? DEFAULT_AGENT_COST;
  }
  return Math.round(cost * 10000) / 10000;
}

/**
 * Build a failed PhaseResult with zero metrics.
 */
export function makeFailedResult(
  phaseId: string,
  plan: WorkflowPlan,
  phase: PlannedPhase,
  startTime: number,
): PhaseResult {
  return {
    phaseId,
    planId: plan.id,
    phaseType: phase.type,
    status: 'failed',
    artifacts: [],
    metrics: {
      duration: Date.now() - startTime,
      agentUtilization: 0,
      modelCost: 0,
    },
  };
}

/**
 * Determine phase status from gate result and skippable flag.
 */
export function resolveStatus(
  gatePassed: boolean,
  skippable: boolean,
): 'completed' | 'failed' | 'skipped' {
  if (gatePassed) return 'completed';
  if (skippable) return 'skipped';
  return 'failed';
}
