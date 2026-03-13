/**
 * Planning Engine.
 *
 * Subscribes to WorkTriaged events and orchestrates:
 * 1. Decision Engine → PlanningInput
 * 2. Template Library → WorkflowTemplate
 * 3. SPARC Decomposer → phases + agents
 * 4. Topology Selector → topology + consensus
 *
 * Publishes PlanCreated events for the Execution Engine (Phase 3).
 */

import { randomUUID } from 'node:crypto';
import type { WorkflowPlan } from '../types';
import type { EventBus } from '../shared/event-bus';
import type { Logger } from '../shared/logger';
import { createDomainEvent } from '../shared/event-bus';
import { PlanningError } from '../shared/errors';
import { TIER_COSTS, DEFAULT_AGENT_COST } from '../shared/constants';
import { createDecisionEngine, type DecisionOutput } from './decision-engine';
import { decompose } from './sparc-decomposer';
import { selectTopology } from './topology-selector';
import { getTemplate } from './template-library';

// ---------------------------------------------------------------------------
// Planning Engine
// ---------------------------------------------------------------------------

export interface PlanningEngineDeps {
  eventBus: EventBus;
  logger: Logger;
}

/**
 * Start the planning engine: subscribe to WorkTriaged, publish PlanCreated.
 * Returns an unsubscribe function for cleanup.
 */
export function startPlanningEngine(deps: PlanningEngineDeps): () => void {
  const { eventBus, logger } = deps;

  const decisionEngine = createDecisionEngine({ logger });

  return eventBus.subscribe('WorkTriaged', (event) => {
    const { intakeEvent, triageResult } = event.payload;
    logger.info('Planning work item', {
      eventId: intakeEvent.id,
      intent: intakeEvent.intent,
      priority: triageResult.priority,
    });

    try {
      // Step 1: Decision Engine → PlanningInput
      const decision: DecisionOutput = decisionEngine.decide({
        intakeEvent,
        triageResult,
      });

      const { planningInput } = decision;

      // Step 2: SPARC Decomposer → phases + agents
      const decomposition = decompose(planningInput);

      // Step 3: Topology Selector → swarm config
      const topology = selectTopology(planningInput);

      // Step 4: Look up template for cost/duration estimates
      const template = getTemplate(planningInput.templateKey);

      // Step 5: Build WorkflowPlan
      const plan: WorkflowPlan = {
        id: randomUUID(),
        workItemId: intakeEvent.id,
        methodology: decomposition.methodology,
        template: planningInput.templateKey,
        topology: topology.topology,
        swarmStrategy: topology.swarmStrategy,
        consensus: topology.consensus,
        maxAgents: topology.maxAgents,
        phases: decomposition.phases,
        agentTeam: decomposition.adjustedAgents,
        estimatedDuration: template?.estimatedDuration ?? estimateDuration(decomposition.phases.length),
        estimatedCost: estimateCost(decomposition.adjustedAgents),
      };

      logger.info('Plan created', {
        planId: plan.id,
        workItemId: plan.workItemId,
        methodology: plan.methodology,
        template: plan.template,
        topology: plan.topology,
        phases: plan.phases.length,
        agents: plan.agentTeam.length,
        maxAgents: plan.maxAgents,
        estimatedDuration: plan.estimatedDuration,
      });

      // Publish PlanCreated event (include intakeEvent for task-tool agents)
      eventBus.publish(
        createDomainEvent('PlanCreated', { workflowPlan: plan, intakeEvent }, event.correlationId),
      );
    } catch (err) {
      const planErr = new PlanningError(
        `Failed to plan work item ${intakeEvent.id}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
      logger.error('Planning failed', { eventId: intakeEvent.id, error: planErr.message });

      // Publish failure event instead of throwing (event bus swallows thrown errors)
      eventBus.publish(
        createDomainEvent('WorkFailed', {
          workItemId: intakeEvent.id,
          failureReason: planErr.message,
          retryCount: 0,
        }, event.correlationId),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Estimation helpers
// ---------------------------------------------------------------------------

function estimateDuration(phaseCount: number): number {
  // Base 5 minutes per phase
  return phaseCount * 5 + 5;
}

function estimateCost(agents: Array<{ tier: number }>): number {
  let cost = 0;
  for (const agent of agents) {
    cost += TIER_COSTS[agent.tier] ?? DEFAULT_AGENT_COST;
  }
  return Math.round(cost * 10000) / 10000;
}
