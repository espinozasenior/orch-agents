/**
 * Slack Notifier.
 *
 * Subscribes to PlanCreated, WorkCompleted, and WorkFailed domain events.
 * Correlates plans to intake context and POSTs formatted messages to a
 * Slack incoming webhook URL. Fire-and-forget -- never blocks the pipeline.
 */

import type { EventBus } from '../kernel/event-bus';
import type { Logger } from '../shared/logger';
import { isGitHubMeta } from '../types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SlackNotifierDeps {
  eventBus: EventBus;
  logger: Logger;
  webhookUrl: string;
}

interface PlanContext {
  repoFullName: string;
  eventType: string;
  skillPath: string;
}

// ---------------------------------------------------------------------------
// Slack message sender (fire-and-forget)
// ---------------------------------------------------------------------------

function sendSlackMessage(webhookUrl: string, text: string, log: Logger): void {
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).then(res => {
    if (!res.ok) {
      log.warn('Slack webhook responded with non-OK status', { status: res.status });
    }
  }).catch(err => {
    log.warn('Slack webhook request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Start the Slack notifier. Returns a cleanup function that unsubscribes
 * all event handlers and clears internal state.
 */
export function startSlackNotifier(deps: SlackNotifierDeps): () => void {
  const { eventBus, logger, webhookUrl } = deps;
  const log = logger.child ? logger.child({ module: 'slack-notifier' }) : logger;

  // Correlation map: planId -> intake context
  const planContext = new Map<string, PlanContext>();

  const unsubPlan = eventBus.subscribe('PlanCreated', (event) => {
    const { workflowPlan, intakeEvent } = event.payload;
    if (!intakeEvent) return;

    const meta = intakeEvent.sourceMetadata;
    let eventType: string;
    let skillPath: string;

    if (isGitHubMeta(meta)) {
      eventType = meta.action ? `${meta.eventType}.${meta.action}` : meta.eventType;
      skillPath = meta.skillPath ?? 'unknown';
    } else {
      eventType = meta.source;
      skillPath = 'unknown';
    }

    planContext.set(workflowPlan.id, {
      repoFullName: intakeEvent.entities.repo ?? 'unknown',
      eventType,
      skillPath,
    });
  });

  const unsubCompleted = eventBus.subscribe('WorkCompleted', (event) => {
    const { planId, totalDuration, phaseCount, output } = event.payload;
    const ctx = planContext.get(planId);
    planContext.delete(planId);
    if (!ctx) return;

    const skillName = ctx.skillPath.split('/').slice(-2, -1)[0] || ctx.skillPath;
    const outputPreview = output ? `\n\n${output}` : '';
    const text = [
      `*Agent completed* on \`${ctx.repoFullName}\``,
      `Event: ${ctx.eventType} | Skill: ${skillName}`,
      `Duration: ${(totalDuration / 1000).toFixed(1)}s | Phases: ${phaseCount}`,
      outputPreview,
    ].filter(Boolean).join('\n');

    sendSlackMessage(webhookUrl, text, log);
  });

  const unsubFailed = eventBus.subscribe('WorkFailed', (event) => {
    const { workItemId, failureReason } = event.payload;
    const text = [
      `*Agent failed* on work item \`${workItemId}\``,
      `Reason: ${failureReason}`,
    ].join('\n');

    sendSlackMessage(webhookUrl, text, log);
  });

  log.info('Slack notifier started', {
    webhookUrl: webhookUrl.length > 40 ? webhookUrl.slice(0, 40) + '...' : webhookUrl,
  });

  return () => {
    unsubPlan();
    unsubCompleted();
    unsubFailed();
    planContext.clear();
  };
}
