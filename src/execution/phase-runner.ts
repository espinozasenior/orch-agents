/**
 * Phase Runner.
 *
 * Executes a single SPARC phase within a workflow plan.
 * Uses a pluggable GateChecker to verify quality gates after execution.
 *
 * In Phase 3 (in-process), this simulates agent work.
 * Phase 4+ will delegate to real agent swarms.
 */

import { randomUUID } from 'node:crypto';
import type { PlannedPhase, PhaseResult, WorkflowPlan } from '../types';
import { TIER_COSTS, DEFAULT_AGENT_COST } from '../shared/constants';

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
}

export interface PhaseRunnerDeps {
  gateChecker: GateChecker;
}

/**
 * Create a PhaseRunner that executes a phase and checks its gate.
 */
export function createPhaseRunner(deps: PhaseRunnerDeps): PhaseRunner {
  const { gateChecker } = deps;

  return {
    async runPhase(plan: WorkflowPlan, phase: PlannedPhase): Promise<PhaseResult> {
      const phaseId = randomUUID();
      const startTime = Date.now();

      // Simulate phase execution (Phase 4+ will delegate to real agents)
      // For now, the "work" is just running the gate check.

      const gateResult = await gateChecker(plan.id, phase);
      const duration = Date.now() - startTime;

      // Determine status based on gate result and skippability
      let status: 'completed' | 'failed' | 'skipped';
      if (gateResult.passed) {
        status = 'completed';
      } else if (phase.skippable) {
        status = 'skipped';
      } else {
        status = 'failed';
      }

      // Calculate agent utilization based on team members
      const agentsInPhase = phase.agents.length;
      const totalAgents = plan.agentTeam.length;
      const agentUtilization = totalAgents > 0 ? agentsInPhase / totalAgents : 0;

      // Estimate model cost based on agent tiers (shared constants)
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
    },
  };
}
