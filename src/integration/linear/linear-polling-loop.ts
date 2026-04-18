/**
 * Linear polling loop for fallback mode.
 *
 * Periodically fetches active issues from Linear, detects state
 * changes via the StateReconciler, normalizes them into IntakeEvents,
 * and publishes to the EventBus. Deduplicates against webhook-delivered events.
 *
 * Supports exponential backoff on rate limit errors.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import type { EventBus } from '../../kernel/event-bus';
import { createDomainEvent } from '../../kernel/event-bus';
import type { LinearClient } from './linear-client';
import { LinearRateLimitError } from './linear-client';
import type { LinearIssueSnapshot, LinearWebhookPayload } from './types';
import { snapshotIssue, detectChanges } from './linear-state-reconciler';
import { normalizeLinearEvent } from './linear-normalizer';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LinearPollingLoopDeps {
  linearClient: LinearClient;
  logger: Logger;
  eventBus: EventBus;
  teamId: string;
  pollIntervalMs: number;
  linearBotUserId?: string;
  /** Set of recently seen event keys for dedup against webhooks */
  recentWebhookKeys?: Set<string>;
}

export interface LinearPollingLoop {
  start(): void;
  stop(): void;
  /** Exposed for testing -- runs a single poll cycle. */
  poll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLinearPollingLoop(deps: LinearPollingLoopDeps): LinearPollingLoop {
  const { linearClient, logger, eventBus, teamId, pollIntervalMs, linearBotUserId } = deps;
  const stateCache = new Map<string, LinearIssueSnapshot>();
  const recentWebhookKeys = deps.recentWebhookKeys ?? new Set<string>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 0;

  async function poll(): Promise<void> {
    try {
      // Apply backoff if needed
      if (backoffMs > 0) {
        logger.info('Linear polling backoff', { backoffMs });
        await sleep(backoffMs);
        backoffMs = 0;
      }

      const issues = await linearClient.fetchActiveIssues(teamId);

      for (const issue of issues) {
        const cached = stateCache.get(issue.id);

        if (!cached) {
          // First seen, cache without emitting
          stateCache.set(issue.id, snapshotIssue(issue));
          continue;
        }

        const changes = detectChanges(cached, issue);

        if (changes.length === 0) {
          continue;
        }

        for (const change of changes) {
          // Build synthetic webhook payload
          const syntheticPayload: LinearWebhookPayload = {
            action: 'update',
            type: 'Issue',
            createdAt: issue.updatedAt,
            data: {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description,
              url: issue.url,
              priority: issue.priority,
              state: issue.state,
              labels: issue.labels.nodes,
              assignee: issue.assignee ?? undefined,
              creator: issue.creator ?? undefined,
              team: issue.team ?? undefined,
              project: issue.project ?? undefined,
              updatedAt: issue.updatedAt,
            },
            updatedFrom: change.updatedFrom,
          };

          const intakeEvent = normalizeLinearEvent(
            syntheticPayload,
            change.updatedFrom,
            { linearBotUserId },
          );

          if (!intakeEvent) {
            continue;
          }

          // Dedup check against webhook-delivered events
          const eventKey = `linear-${issue.id}-${change.field}-${issue.updatedAt}`;
          if (recentWebhookKeys.has(eventKey)) {
            logger.debug('Polling event deduped against webhook', { eventKey });
            continue;
          }

          const domainEvent = createDomainEvent(
            'IntakeCompleted',
            { intakeEvent },
            randomUUID(),
          );
          eventBus.publish(domainEvent);

          logger.info('Polling detected change', {
            issueId: issue.id,
            field: change.field,
            from: change.from,
            to: change.to,
          });
        }

        stateCache.set(issue.id, snapshotIssue(issue));
      }
    } catch (err) {
      if (err instanceof LinearRateLimitError) {
        backoffMs = Math.min(err.retryAfter * 1000, 120_000);
        logger.warn('Linear polling rate limited, backing off', {
          retryAfter: err.retryAfter,
          backoffMs,
        });
      } else {
        logger.error('Linear polling error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async function schedulePoll(): Promise<void> {
    await poll();
    if (timer !== null) {
      timer = setTimeout(() => void schedulePoll(), pollIntervalMs);
      if (timer.unref) {
        timer.unref();
      }
    }
  }

  return {
    start() {
      if (timer) return;
      // Use a sentinel value so schedulePoll knows we're running
      timer = setTimeout(() => {}, 0);
      void schedulePoll();
    },

    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    poll,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
