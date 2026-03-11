/**
 * Triage Engine.
 *
 * Subscribes to IntakeCompleted events, evaluates urgency / complexity / impact,
 * and publishes WorkTriaged events for the Planning Engine.
 *
 * Uses config/urgency-rules.json for scoring weights and thresholds.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IntakeEvent, TriageResult, SPARCPhase } from '../types';
import type { EventBus } from '../shared/event-bus';
import type { Logger } from '../shared/logger';
import { createDomainEvent } from '../shared/event-bus';
import { TriageError } from '../shared/errors';

// ---------------------------------------------------------------------------
// Urgency rules types
// ---------------------------------------------------------------------------

interface UrgencyRules {
  priorityWeights: {
    severity: number;
    impact: number;
    skipTriage: number;
    labelBoost: number;
    recency: number;
  };
  severityScores: Record<string, number>;
  impactScores: Record<string, number>;
  labelBoosts: Record<string, number>;
  priorityThresholds: Record<string, number>;
  effortMapping: Record<string, { maxComplexity: number; maxFiles: number }>;
}

// ---------------------------------------------------------------------------
// Load urgency rules
// ---------------------------------------------------------------------------

let _rules: UrgencyRules | undefined;

function getRules(): UrgencyRules {
  if (!_rules) {
    const filePath = resolve(__dirname, '..', '..', 'config', 'urgency-rules.json');
    const raw = readFileSync(filePath, 'utf-8');
    _rules = JSON.parse(raw) as UrgencyRules;
  }
  return _rules;
}

/** Override rules for testing. */
export function setUrgencyRules(rules: UrgencyRules): void {
  _rules = rules;
}

/** Reset to force reload from disk. */
export function resetUrgencyRules(): void {
  _rules = undefined;
}

// ---------------------------------------------------------------------------
// Triage logic
// ---------------------------------------------------------------------------

/**
 * Triage an IntakeEvent into a TriageResult.
 *
 * Evaluates priority, complexity, impact, risk, and recommended SPARC phases.
 */
export function triageEvent(event: IntakeEvent): TriageResult {
  const rules = getRules();
  const meta = event.sourceMetadata as Record<string, unknown>;

  // If skipTriage is set in routing, fast-path with routing-provided values
  if (meta.skipTriage === true) {
    return buildFastTriageResult(event, meta);
  }

  const severity = event.entities.severity ?? 'medium';
  const impact = assessImpact(event);
  const complexityPct = assessComplexity(event);
  const labelScore = computeLabelBoost(event.entities.labels ?? [], rules);

  // Weighted priority score
  const urgencyScore =
    (rules.severityScores[severity] ?? 0.5) * rules.priorityWeights.severity +
    (rules.impactScores[impact] ?? 0.5) * rules.priorityWeights.impact +
    labelScore * rules.priorityWeights.labelBoost +
    0.5 * rules.priorityWeights.recency; // default recency

  const priority = scoreToPriority(urgencyScore, rules);
  const risk = assessRisk(severity, impact, complexityPct);
  const effort = assessEffort(complexityPct, event.entities.files?.length ?? 0, rules);
  const phases = determineSPARCPhases(event, meta, complexityPct);

  return {
    intakeEventId: event.id,
    priority,
    complexity: { level: complexityLevel(complexityPct), percentage: complexityPct },
    impact,
    risk,
    recommendedPhases: phases,
    requiresApproval: risk === 'critical' || priority === 'P0-immediate',
    skipTriage: false,
    estimatedEffort: effort,
  };
}

// ---------------------------------------------------------------------------
// Fast triage (for skipTriage=true routing rules)
// ---------------------------------------------------------------------------

function buildFastTriageResult(
  event: IntakeEvent,
  meta: Record<string, unknown>,
): TriageResult {
  const phases = (meta.phases as string[] | undefined) ?? ['refinement'];

  return {
    intakeEventId: event.id,
    priority: normalizePriority(event.entities.severity ?? 'medium'),
    complexity: { level: 'low', percentage: 15 },
    impact: 'isolated',
    risk: 'low',
    recommendedPhases: phases as SPARCPhase[],
    requiresApproval: false,
    skipTriage: true,
    estimatedEffort: 'small',
  };
}

// ---------------------------------------------------------------------------
// Assessment helpers
// ---------------------------------------------------------------------------

function assessImpact(event: IntakeEvent): 'isolated' | 'module' | 'cross-cutting' | 'system-wide' {
  const files = event.entities.files ?? [];
  const labels = event.entities.labels ?? [];

  if (labels.includes('system-wide') || files.length > 20) return 'system-wide';

  // Check if files span multiple directories
  if (files.length > 0) {
    const dirs = new Set(files.map((f) => f.split('/')[0]));
    if (dirs.size > 2) return 'cross-cutting';
  }

  if (files.length > 3 || labels.includes('cross-cutting')) return 'module';

  return 'isolated';
}

function assessComplexity(event: IntakeEvent): number {
  const files = event.entities.files ?? [];
  const labels = event.entities.labels ?? [];

  let score = 20; // base

  // File count contribution
  score += Math.min(files.length * 3, 40);

  // Label-based complexity hints
  if (labels.includes('bug')) score += 10;
  if (labels.includes('security')) score += 20;
  if (labels.includes('enhancement')) score += 15;
  if (labels.includes('refactor')) score += 10;

  // Intent-based adjustment
  const intent = event.intent;
  if (intent === 'incident-response') score += 25;
  if (intent === 'deploy-release') score += 15;
  if (intent === 'debug-ci') score += 10;
  if (intent.startsWith('custom:build-feature')) score += 20;

  return Math.min(score, 100);
}

function assessRisk(
  severity: string,
  impact: string,
  complexity: number,
): 'low' | 'medium' | 'high' | 'critical' {
  let riskScore = 0;

  if (severity === 'critical') riskScore += 40;
  else if (severity === 'high') riskScore += 25;
  else if (severity === 'medium') riskScore += 10;

  if (impact === 'system-wide') riskScore += 30;
  else if (impact === 'cross-cutting') riskScore += 20;
  else if (impact === 'module') riskScore += 10;

  riskScore += complexity * 0.3;

  if (riskScore >= 70) return 'critical';
  if (riskScore >= 45) return 'high';
  if (riskScore >= 20) return 'medium';
  return 'low';
}

function assessEffort(
  complexity: number,
  fileCount: number,
  rules: UrgencyRules,
): 'trivial' | 'small' | 'medium' | 'large' | 'epic' {
  for (const [effort, thresholds] of Object.entries(rules.effortMapping)) {
    if (complexity <= thresholds.maxComplexity && fileCount <= thresholds.maxFiles) {
      return effort as 'trivial' | 'small' | 'medium' | 'large' | 'epic';
    }
  }
  return 'epic';
}

function determineSPARCPhases(
  _event: IntakeEvent,
  meta: Record<string, unknown>,
  complexity: number,
): SPARCPhase[] {
  // Use routing-provided phases as base if available
  const routingPhases = meta.phases as string[] | undefined;
  if (routingPhases && routingPhases.length > 0) {
    return routingPhases as SPARCPhase[];
  }

  // Otherwise derive from complexity
  if (complexity >= 70) {
    return ['specification', 'pseudocode', 'architecture', 'refinement', 'completion'];
  }
  if (complexity >= 40) {
    return ['specification', 'refinement', 'completion'];
  }
  if (complexity >= 20) {
    return ['refinement', 'completion'];
  }
  return ['refinement'];
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function computeLabelBoost(labels: string[], rules: UrgencyRules): number {
  if (labels.length === 0) return 0;
  let boost = 0;
  for (const label of labels) {
    boost += rules.labelBoosts[label] ?? 0;
  }
  return Math.max(0, Math.min(1, boost));
}

function scoreToPriority(
  score: number,
  rules: UrgencyRules,
): 'P0-immediate' | 'P1-high' | 'P2-standard' | 'P3-backlog' {
  if (score >= rules.priorityThresholds['P0-immediate']) return 'P0-immediate';
  if (score >= rules.priorityThresholds['P1-high']) return 'P1-high';
  if (score >= rules.priorityThresholds['P2-standard']) return 'P2-standard';
  return 'P3-backlog';
}

function normalizePriority(
  severity: string,
): 'P0-immediate' | 'P1-high' | 'P2-standard' | 'P3-backlog' {
  switch (severity) {
    case 'critical': return 'P0-immediate';
    case 'high': return 'P1-high';
    case 'medium': return 'P2-standard';
    case 'low': return 'P3-backlog';
    default: return 'P2-standard';
  }
}

function complexityLevel(pct: number): 'low' | 'medium' | 'high' {
  if (pct >= 60) return 'high';
  if (pct >= 30) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Event bus wiring
// ---------------------------------------------------------------------------

export interface TriageEngineDeps {
  eventBus: EventBus;
  logger: Logger;
}

/**
 * Start the triage engine: subscribe to IntakeCompleted, publish WorkTriaged.
 * Returns an unsubscribe function for cleanup.
 */
export function startTriageEngine(deps: TriageEngineDeps): () => void {
  const { eventBus, logger } = deps;

  return eventBus.subscribe('IntakeCompleted', (event) => {
    const intakeEvent = event.payload.intakeEvent;
    logger.info('Triaging intake event', { eventId: intakeEvent.id, intent: intakeEvent.intent });

    try {
      const triageResult = triageEvent(intakeEvent);

      logger.info('Triage complete', {
        eventId: intakeEvent.id,
        priority: triageResult.priority,
        complexity: triageResult.complexity.level,
        impact: triageResult.impact,
        risk: triageResult.risk,
        effort: triageResult.estimatedEffort,
      });

      eventBus.publish(
        createDomainEvent('WorkTriaged', {
          intakeEvent,
          triageResult,
        }, event.correlationId),
      );
    } catch (err) {
      const triageErr = new TriageError(
        `Failed to triage event ${intakeEvent.id}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
      logger.error('Triage failed', { eventId: intakeEvent.id, error: triageErr.message });
      throw triageErr;
    }
  });
}
