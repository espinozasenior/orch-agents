/**
 * Slack Responder.
 *
 * Subscribes to WorkCompleted, WorkFailed, and PlanCreated domain events.
 * When the original IntakeEvent source is 'slack', posts a threaded reply.
 * Also handles broadcast notifications (absorbs slack-notifier's responsibility).
 *
 * Uses Slack Web API: POST https://slack.com/api/chat.postMessage.
 */

import type { EventBus } from '../../kernel/event-bus';
import type { Logger } from '../../shared/logger';
import { isSlackMeta, isGitHubMeta } from '../../types';
import type { IntakeEvent } from '../../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackResponderDeps {
  eventBus: EventBus;
  logger: Logger;
  slackBotToken: string;
  /** Optional incoming webhook URL for broadcast notifications (PlanCreated, etc.) */
  broadcastWebhookUrl?: string;
}

interface PlanContext {
  intakeEvent?: IntakeEvent;
  repoFullName: string;
  eventType: string;
  skillPath: string;
}

// ---------------------------------------------------------------------------
// Slack API helper
// ---------------------------------------------------------------------------

function postSlackMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs: string | undefined,
  log: Logger,
): void {
  const body: Record<string, unknown> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;

  fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  }).then((res) => res.json()).then((data) => {
    const result = data as { ok?: boolean; error?: string };
    if (!result.ok) {
      log.warn('Slack API responded with error', { error: result.error });
    }
  }).catch((err) => {
    log.warn('Slack API request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function sendWebhookMessage(webhookUrl: string, text: string, log: Logger): void {
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).then((res) => {
    if (!res.ok) {
      log.warn('Slack webhook responded with non-OK status', { status: res.status });
    }
  }).catch((err) => {
    log.warn('Slack webhook request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SlackResponder {
  start(): void;
  stop(): void;
}

export function createSlackResponder(deps: SlackResponderDeps): SlackResponder {
  const { eventBus, logger, slackBotToken, broadcastWebhookUrl } = deps;
  const log = logger.child ? logger.child({ module: 'slack-responder' }) : logger;
  const planContext = new Map<string, PlanContext>();
  const unsubscribers: (() => void)[] = [];

  return {
    start() {
      // PlanCreated: correlate and optionally broadcast
      unsubscribers.push(eventBus.subscribe('PlanCreated', (event) => {
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
          intakeEvent,
          repoFullName: intakeEvent.entities.repo ?? 'unknown',
          eventType,
          skillPath,
        });

        // Broadcast notification
        if (broadcastWebhookUrl) {
          const text = `*Plan created* for \`${intakeEvent.entities.repo ?? 'unknown'}\` | Event: ${eventType}`;
          sendWebhookMessage(broadcastWebhookUrl, text, log);
        }
      }));

      // WorkCompleted: thread reply for Slack source, broadcast for all
      unsubscribers.push(eventBus.subscribe('WorkCompleted', (event) => {
        const { planId, totalDuration, phaseCount, output } = event.payload;
        const ctx = planContext.get(planId);
        planContext.delete(planId);

        // Thread reply for Slack-sourced work
        if (ctx?.intakeEvent && isSlackMeta(ctx.intakeEvent.sourceMetadata)) {
          const meta = ctx.intakeEvent.sourceMetadata;
          const outputPreview = output ? `\n\n${output.slice(0, 1000)}` : '';
          const text = `Completed in ${(totalDuration / 1000).toFixed(1)}s (${phaseCount} phase${phaseCount !== 1 ? 's' : ''}).${outputPreview}`;
          postSlackMessage(slackBotToken, meta.channelId, text, meta.threadTs, log);
        }

        // Broadcast notification
        if (broadcastWebhookUrl && ctx) {
          const skillName = ctx.skillPath.split('/').slice(-2, -1)[0] || ctx.skillPath;
          const text = [
            `*Agent completed* on \`${ctx.repoFullName}\``,
            `Event: ${ctx.eventType} | Skill: ${skillName}`,
            `Duration: ${(totalDuration / 1000).toFixed(1)}s | Phases: ${phaseCount}`,
          ].join('\n');
          sendWebhookMessage(broadcastWebhookUrl, text, log);
        }
      }));

      // WorkFailed: thread reply for Slack source, broadcast for all
      unsubscribers.push(eventBus.subscribe('WorkFailed', (event) => {
        const { workItemId, failureReason } = event.payload;

        // Check all plan contexts for slack source
        for (const [pid, ctx] of planContext) {
          if (ctx.intakeEvent && isSlackMeta(ctx.intakeEvent.sourceMetadata)) {
            const meta = ctx.intakeEvent.sourceMetadata;
            postSlackMessage(
              slackBotToken,
              meta.channelId,
              `Failed: ${failureReason}`,
              meta.threadTs,
              log,
            );
            planContext.delete(pid);
            break;
          }
        }

        // Broadcast notification
        if (broadcastWebhookUrl) {
          const text = `*Agent failed* on work item \`${workItemId}\`\nReason: ${failureReason}`;
          sendWebhookMessage(broadcastWebhookUrl, text, log);
        }
      }));

      log.info('Slack responder started');
    },

    stop() {
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;
      planContext.clear();
      log.info('Slack responder stopped');
    },
  };
}
