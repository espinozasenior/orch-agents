/**
 * Triage Engine (simplified).
 *
 * Assigns P0-P3 priority based on simple label/severity checks.
 * No SPARC phases, no effort estimation, no complex scoring weights.
 *
 * The triage result is informational only -- the execution engine
 * reads templates and agent lists directly from WORKFLOW.md.
 */

import type { IntakeEvent, TriageResult } from '../types';
import type { EventBus } from '../kernel/event-bus';
import type { Logger } from '../shared/logger';
import { createDomainEvent } from '../kernel/event-bus';
import { workItemId as wId } from '../kernel/branded-types';
import { TriageError } from '../kernel/errors';

// ---------------------------------------------------------------------------
// Triage logic
// ---------------------------------------------------------------------------

/**
 * Triage an IntakeEvent into a TriageResult.
 *
 * Simple label-based priority assignment:
 * - Label "security" or "P0" -> P0
 * - Label "bug", "hotfix", or "P1" -> P1
 * - Label "documentation" or "P3" -> P3
 * - Default -> P2
 *
 * Also respects severity from the intake event and skipTriage flag.
 */
export function triageEvent(event: IntakeEvent): TriageResult {
  const meta = event.sourceMetadata as unknown as Record<string, unknown>;

  if (meta.skipTriage === true) {
    return {
      intakeEventId: event.id,
      priority: severityToPriority(event.entities.severity ?? 'medium'),
      skipTriage: true,
    };
  }

  const labels = event.entities.labels ?? [];
  const priority = derivePriority(labels, event.entities.severity);

  return {
    intakeEventId: event.id,
    priority,
    skipTriage: false,
  };
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

function derivePriority(
  labels: string[],
  severity?: string,
): 'P0-immediate' | 'P1-high' | 'P2-standard' | 'P3-backlog' {
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));

  if (labelSet.has('security') || labelSet.has('p0') || severity === 'critical') {
    return 'P0-immediate';
  }
  if (labelSet.has('bug') || labelSet.has('hotfix') || labelSet.has('p1') || severity === 'high') {
    return 'P1-high';
  }
  if (labelSet.has('documentation') || labelSet.has('p3') || severity === 'low') {
    return 'P3-backlog';
  }
  return 'P2-standard';
}

function severityToPriority(
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
    logger.info('Triaging intake event', { eventId: intakeEvent.id, ruleKey: intakeEvent.sourceMetadata.source === 'github' ? intakeEvent.sourceMetadata.ruleKey : undefined });

    try {
      const triageResult = triageEvent(intakeEvent);

      logger.info('Triage complete', {
        eventId: intakeEvent.id,
        priority: triageResult.priority,
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

      eventBus.publish(
        createDomainEvent('WorkFailed', {
          workItemId: wId(intakeEvent.id),
          failureReason: triageErr.message,
          retryCount: 0,
        }, event.correlationId),
      );
    }
  });
}
