/**
 * Slack event normalizer.
 *
 * Transforms Slack app_mention and message events into canonical IntakeEvents.
 * Resolves repos by matching message text against WORKFLOW.md repo keys.
 * Pure function -- no I/O.
 */

import { randomUUID } from 'node:crypto';
import type { IntakeEvent, SlackSourceMetadata } from '../../types';
import type { SlackEvent } from './types';
import type { WorkflowConfig } from '../../config';
import { sanitize } from '../../shared/input-sanitizer';

// ---------------------------------------------------------------------------
// Bot mention stripper
// ---------------------------------------------------------------------------

/**
 * Strip the leading bot mention from an app_mention event text.
 * Slack formats bot mentions as `<@U12345>`.
 */
function stripBotMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/i, '').trim();
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a repository from message text by matching against WORKFLOW.md repos.
 *
 * Checks for explicit "in <repo-name>" patterns first, then partial matches
 * against repo keys. Returns undefined if ambiguous or no match.
 */
function resolveRepo(text: string, workflowConfig: WorkflowConfig): string | undefined {
  const repoKeys = Object.keys(workflowConfig.repos);
  if (repoKeys.length === 0) return undefined;

  // Check for explicit "in <repo>" pattern
  const explicitMatch = text.match(/\bin\s+([\w\-./]+)/i);
  if (explicitMatch) {
    const candidate = explicitMatch[1].toLowerCase();
    const match = repoKeys.find((key) => key.toLowerCase() === candidate || key.toLowerCase().endsWith(`/${candidate}`));
    if (match) return match;
  }

  // Partial match against repo keys
  const matches = repoKeys.filter((key) => {
    const shortName = key.includes('/') ? key.split('/').pop()! : key;
    return text.toLowerCase().includes(shortName.toLowerCase());
  });

  // Only return if exactly one match (unambiguous)
  if (matches.length === 1) return matches[0];

  // Single repo configured — use it as default
  if (repoKeys.length === 1) return repoKeys[0];

  return undefined;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a Slack event into an IntakeEvent.
 *
 * @param event - A Slack event (app_mention or message)
 * @param workflowConfig - The workflow config for repo resolution
 * @returns An IntakeEvent
 */
export function normalizeSlackEvent(
  event: SlackEvent,
  workflowConfig: WorkflowConfig,
): IntakeEvent {
  const cleanText = event.type === 'app_mention'
    ? stripBotMention(event.text)
    : event.text;

  const repo = resolveRepo(cleanText, workflowConfig);

  const sourceMetadata: SlackSourceMetadata = {
    source: 'slack',
    channelId: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    userId: event.user,
  };

  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: 'slack',
    sourceMetadata,
    entities: {
      repo,
      author: event.user,
    },
    rawText: sanitize(cleanText),
  };
}
