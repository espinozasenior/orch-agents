/**
 * Decision Engine (Stage 1).
 *
 * Combines triage results with tech-lead-router classification
 * to produce a PlanningInput for the planning engine.
 *
 * Stage 1: Heuristic-based (tech-lead-router + urgency rules).
 * Stage 2-3: Q-Learning / neural (Phase 6 milestones).
 */

import type { IntakeEvent, TriageResult, PlanningInput, PlannedAgent } from '../types';
import type { Logger } from '../shared/logger';
import * as routerBridge from '../router-bridge';

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

export interface DecisionContext {
  intakeEvent: IntakeEvent;
  triageResult: TriageResult;
}

export interface DecisionOutput {
  planningInput: PlanningInput;
  routerDecision: {
    template: string;
    topology: string;
    strategy: string;
    agents: Array<{ role: string; type: string; tier: number }>;
    ambiguity: { score: number; needsClarification: boolean };
  };
}

// ---------------------------------------------------------------------------
// Decision Engine
// ---------------------------------------------------------------------------

export interface DecisionEngineDeps {
  logger: Logger;
}

/**
 * Create a decision engine instance.
 *
 * Uses the tech-lead-router bridge for classification and the
 * triage result for urgency/priority context.
 */
export function createDecisionEngine(deps: DecisionEngineDeps) {
  const { logger } = deps;

  return {
    /**
     * Produce a PlanningInput from an IntakeEvent + TriageResult.
     */
    decide(ctx: DecisionContext): DecisionOutput {
      const { intakeEvent, triageResult } = ctx;

      // Build a task description for the tech-lead-router
      const taskDescription = buildTaskDescription(intakeEvent);
      logger.debug('Decision engine input', { taskDescription, intent: intakeEvent.intent });

      // Run through the tech-lead-router (catch CJS module errors)
      let routerResult;
      try {
        routerResult = routerBridge.makeDecision(taskDescription);
      } catch (routerErr) {
        logger.error('Router bridge failed', {
          error: routerErr instanceof Error ? routerErr.message : String(routerErr),
        });
        throw new Error(
          `Tech-lead-router failed for "${taskDescription.slice(0, 80)}": ${routerErr instanceof Error ? routerErr.message : String(routerErr)}`,
        );
      }

      // Merge triage classification with router classification
      const classification = {
        domain: routerResult.classification.domain,
        complexity: {
          level: triageResult.complexity.level,
          percentage: triageResult.complexity.percentage,
        },
        scope: routerResult.classification.scope,
        risk: triageResult.risk,
      };

      // Map router agents to PlannedAgent
      const agentTeam: PlannedAgent[] = routerResult.agents.map((a) => ({
        role: a.role,
        type: a.type,
        tier: a.tier as 1 | 2 | 3,
        required: a.role === 'lead' || a.role === 'implementer',
      }));

      // Determine template key: prefer routing-provided, fall back to router
      const meta = intakeEvent.sourceMetadata as Record<string, unknown>;
      const templateKey = typeof meta.template === 'string'
        ? meta.template
        : routerResult.template;

      const planningInput: PlanningInput = {
        intakeEventId: intakeEvent.id,
        triageResult,
        classification,
        templateKey,
        agentTeam,
        ambiguity: {
          score: routerResult.ambiguity.score,
          needsClarification: routerResult.ambiguity.needsClarification,
        },
      };

      logger.info('Decision made', {
        eventId: intakeEvent.id,
        template: templateKey,
        domain: classification.domain,
        complexity: classification.complexity.level,
        agents: agentTeam.length,
        ambiguity: routerResult.ambiguity.score,
      });

      return {
        planningInput,
        routerDecision: {
          template: routerResult.template,
          topology: routerResult.topology,
          strategy: routerResult.strategy,
          agents: routerResult.agents,
          ambiguity: {
            score: routerResult.ambiguity.score,
            needsClarification: routerResult.ambiguity.needsClarification,
          },
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a human-readable task description from an IntakeEvent.
 * This is fed to the tech-lead-router for classification.
 */
function buildTaskDescription(event: IntakeEvent): string {
  const parts: string[] = [];

  // Intent
  parts.push(`[${event.intent}]`);

  // Repo context
  if (event.entities.repo) {
    parts.push(`repo:${event.entities.repo}`);
  }

  // Branch/PR/Issue context
  if (event.entities.branch) parts.push(`branch:${event.entities.branch}`);
  if (event.entities.prNumber) parts.push(`PR #${event.entities.prNumber}`);
  if (event.entities.issueNumber) parts.push(`Issue #${event.entities.issueNumber}`);

  // Labels
  if (event.entities.labels && event.entities.labels.length > 0) {
    parts.push(`labels:${event.entities.labels.join(',')}`);
  }

  // Files
  if (event.entities.files && event.entities.files.length > 0) {
    const fileList = event.entities.files.slice(0, 5).join(', ');
    const suffix = event.entities.files.length > 5
      ? ` (+${event.entities.files.length - 5} more)`
      : '';
    parts.push(`files: ${fileList}${suffix}`);
  }

  // Raw text (truncated)
  if (event.rawText) {
    const truncated = event.rawText.length > 200
      ? event.rawText.slice(0, 200) + '...'
      : event.rawText;
    parts.push(truncated);
  }

  return parts.join(' ');
}
