/**
 * Anti-corruption layer: converts automation triggers into IntakeEvent
 * objects consumable by the existing pipeline (IntakeCompleted event).
 */

import { randomUUID } from 'node:crypto';
import type { IntakeEvent, AutomationSourceMetadata } from '../types';
import type { AutomationConfig } from '../config/workflow-config';

/**
 * Build an IntakeEvent from an automation trigger.
 *
 * The event is shaped so the existing execution engine can process it
 * without any special-casing -- it looks like any other intake event
 * with `source: 'automation'`.
 */
export function buildAutomationIntakeEvent(
  automationId: string,
  repoName: string,
  config: AutomationConfig,
  trigger: 'cron' | 'webhook' | 'manual',
): IntakeEvent {
  const sourceMetadata: AutomationSourceMetadata = {
    source: 'automation',
    automationId,
    trigger,
    ...(config.skill ? { skillPath: config.skill } : {}),
  };

  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: 'automation',
    sourceMetadata,
    entities: {
      repo: repoName,
    },
    rawText: config.instruction,
  };
}
