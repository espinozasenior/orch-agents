/**
 * GitHub event normalizer using WORKFLOW.md configuration.
 *
 * Replaces config/github-routing.json when WORKFLOW_MD_GITHUB=true.
 * Reads github.events from WorkflowConfig instead of a separate JSON file.
 *
 * Follows the same pattern as github-normalizer.ts but derives rules
 * from WORKFLOW.md's github.events section.
 */

import type { IntakeEvent, WorkIntent } from '../types';
import type { ParsedGitHubEvent } from '../webhook-gateway/event-parser';
import type { WorkflowConfig } from '../integration/linear/workflow-parser';
import { sanitize } from '../shared/input-sanitizer';
import { isAgentCommit } from '../shared/agent-commit-tracker';

// ---------------------------------------------------------------------------
// Bot user ID/username for loop prevention (mirrors github-normalizer.ts)
// TODO: Refactor to use config injection instead of module-level state.
//       Both this file and linear-normalizer.ts maintain separate bot identity
//       state with setter functions. A shared BotIdentity config object should
//       be injected via the factory/normalizer call instead. (Low priority)
// ---------------------------------------------------------------------------

let _botUserId: number = 0;
let _botUsername: string = '';

/**
 * Set the bot user ID for loop prevention.
 */
export function setBotUserId(id: number): void {
  _botUserId = id;
}

/**
 * Set the bot username for loop prevention.
 */
export function setBotUsername(name: string): void {
  _botUsername = name;
}

// ---------------------------------------------------------------------------
// Rule key parsing
// ---------------------------------------------------------------------------

/**
 * Known event types that have standard GitHub actions.
 */
const KNOWN_ACTION_EVENTS: Record<string, string[]> = {
  pull_request: ['opened', 'synchronize', 'closed', 'ready_for_review'],
  issues: ['opened', 'labeled'],
  issue_comment: ['created'],
  pull_request_review: ['submitted'],
  workflow_run: ['completed'],
  release: ['published'],
};

export interface ParsedRuleKey {
  event: string;
  action: string | null;
  condition: string | null;
}

/**
 * Parse a WORKFLOW.md event rule key into structured components.
 *
 * Format: event.action.condition or event.condition (for no-action events).
 *
 * Examples:
 *   pull_request.opened -> { event: 'pull_request', action: 'opened', condition: null }
 *   push.default_branch -> { event: 'push', action: null, condition: 'default_branch' }
 *   issues.labeled.bug  -> { event: 'issues', action: 'labeled', condition: 'bug' }
 */
export function parseRuleKey(ruleKey: string): ParsedRuleKey {
  const parts = ruleKey.split('.');

  if (parts.length === 1) {
    return { event: parts[0], action: null, condition: null };
  }

  // Check for two-part event names like pull_request_review, issue_comment, etc.
  // These are already underscored in the key (not dotted), so parts[0] is the full event.
  const event = parts[0];
  const remaining = parts.slice(1);

  // Handle case where event name has underscores but is split by dots in the YAML
  // Actually, event names like "pull_request" use underscores, not dots, so they're a single segment.

  if (remaining.length === 0) {
    return { event, action: null, condition: null };
  }

  if (remaining.length === 1) {
    const segment = remaining[0];
    // If this event is known to have actions, and the segment is a known action
    if (event in KNOWN_ACTION_EVENTS && KNOWN_ACTION_EVENTS[event].includes(segment)) {
      return { event, action: segment, condition: null };
    }
    // Otherwise treat as condition (e.g., push.default_branch)
    return { event, action: null, condition: segment };
  }

  if (remaining.length === 2) {
    return { event, action: remaining[0], condition: remaining[1] };
  }

  // Fallback: treat first remaining as action, rest as condition
  return { event, action: remaining[0], condition: remaining.slice(1).join('.') };
}

// ---------------------------------------------------------------------------
// Condition matching (replicates github-normalizer.ts logic)
// ---------------------------------------------------------------------------

function matchesCondition(condition: string, parsed: ParsedGitHubEvent): boolean {
  switch (condition) {
    case 'default_branch':
      return parsed.branch === parsed.defaultBranch;

    case 'other':
    case 'other_branch':
      return parsed.branch !== null && parsed.branch !== parsed.defaultBranch;

    case 'merged':
      return parsed.merged === true;

    case 'mentions_bot':
      if (!parsed.commentBody) return false;
      if (_botUsername) return parsed.commentBody.includes(`@${_botUsername}`);
      return true;

    case 'changes_requested':
      return parsed.reviewState === 'changes_requested';

    case 'failure':
      return parsed.conclusion === 'failure';

    default:
      // Treat condition as a label name
      return parsed.labels.includes(condition);
  }
}

// ---------------------------------------------------------------------------
// Event rule matching
// ---------------------------------------------------------------------------

function matchGitHubEventRule(
  parsed: ParsedGitHubEvent,
  events: Record<string, string>,
): string | null {
  for (const [ruleKey, template] of Object.entries(events)) {
    const rule = parseRuleKey(ruleKey);

    // Event type must match
    if (rule.event !== parsed.eventType) continue;

    // Action match (if rule specifies one)
    if (rule.action !== null && rule.action !== parsed.action) continue;

    // Condition match (if rule specifies one)
    if (rule.condition !== null && !matchesCondition(rule.condition, parsed)) continue;

    // All filters passed
    return template;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Intent derivation
// ---------------------------------------------------------------------------

function deriveIntent(parsed: ParsedGitHubEvent, _template: string): WorkIntent {
  const { eventType, action } = parsed;

  if (eventType === 'push') {
    return parsed.branch === parsed.defaultBranch ? 'validate-main' : 'validate-branch';
  }

  if (eventType === 'pull_request') {
    switch (action) {
      case 'opened':
      case 'ready_for_review':
        return 'review-pr';
      case 'synchronize':
        return 're-review-pr';
      case 'closed':
        return parsed.merged ? 'post-merge' : 'review-pr';
      default:
        return 'review-pr';
    }
  }

  if (eventType === 'issues') {
    if (action === 'opened') return 'triage-issue';
    if (action === 'labeled') {
      if (parsed.labels.includes('bug')) return 'custom:fix-bug';
      if (parsed.labels.includes('enhancement')) return 'custom:build-feature';
      if (parsed.labels.length > 0) return `custom:${parsed.labels[0]}`;
      return 'triage-issue';
    }
    return 'triage-issue';
  }

  if (eventType === 'issue_comment') return 'respond-comment';
  if (eventType === 'pull_request_review') return 'custom:address-review';
  if (eventType === 'workflow_run') return 'debug-ci';
  if (eventType === 'release') return 'deploy-release';
  if (eventType === 'deployment_status') return 'incident-response';

  return 'triage-issue';
}

// ---------------------------------------------------------------------------
// Template to severity mapping
// ---------------------------------------------------------------------------

function templateToSeverity(template: string): 'low' | 'medium' | 'high' | 'critical' {
  switch (template) {
    case 'cicd-pipeline':
    case 'release-pipeline':
      return 'high';
    case 'monitoring-alerting':
    case 'security-audit':
      return 'critical';
    case 'quick-fix':
      return 'low';
    default:
      return 'medium';
  }
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a parsed GitHub event using WORKFLOW.md's github.events section.
 *
 * Returns null if:
 * - The sender is the bot (loop prevention)
 * - No github.events section exists in the config
 *
 * Falls back to agents.routing for label matching, then to agents.routing.default.
 */
export function normalizeGitHubEventFromWorkflow(
  parsed: ParsedGitHubEvent,
  workflowConfig: WorkflowConfig,
  botUsername?: string,
): IntakeEvent | null {
  // Allow explicit botUsername override (for testing)
  const effectiveBotUsername = botUsername ?? _botUsername;

  // Bot loop prevention (identical to existing normalizer)
  if (effectiveBotUsername && parsed.sender === effectiveBotUsername) {
    return null;
  }
  if (_botUserId > 0 && parsed.senderId === _botUserId) {
    return null;
  }
  if (parsed.senderIsBot && _botUserId === 0) {
    return null;
  }

  // Agent commit loop prevention — skip webhooks triggered by our own pushes
  if (parsed.eventType === 'push') {
    const headCommitId = (parsed.rawPayload as Record<string, unknown> & { head_commit?: { id?: string } }).head_commit?.id;
    if (headCommitId && isAgentCommit(headCommitId)) {
      return null;
    }
  }

  if (parsed.eventType === 'pull_request' && parsed.action === 'synchronize') {
    const afterSha = (parsed.rawPayload as Record<string, unknown> & { after?: string }).after;
    if (afterSha && isAgentCommit(afterSha)) {
      return null;
    }
  }

  const githubEvents = workflowConfig.github?.events;
  if (!githubEvents || Object.keys(githubEvents).length === 0) {
    return null; // No github events configured, caller should fall back
  }

  // Try to match event rules
  let template = matchGitHubEventRule(parsed, githubEvents);

  // Push to non-default branch with no matching rule — skip instead of falling
  // through to defaultTemplate. This prevents agent branch pushes from spawning
  // new work items when WORKFLOW.md has no push.other rule.
  if (template === null && parsed.eventType === 'push' && parsed.branch !== parsed.defaultBranch) {
    return null;
  }

  // Fallback 1: shared label routing via agents.routing
  if (template === null && parsed.labels.length > 0) {
    for (const label of parsed.labels) {
      const routingTemplate = workflowConfig.agents.routing[label.toLowerCase()];
      if (routingTemplate) {
        template = routingTemplate;
        break;
      }
    }
  }

  // Fallback 2: default template
  if (template === null) {
    template = workflowConfig.agents.defaultTemplate;
  }

  // Derive intent from event context
  const intent = deriveIntent(parsed, template);

  // Determine skipTriage based on template
  const skipTriage = template === 'quick-fix';

  const intakeEvent: IntakeEvent = {
    id: parsed.deliveryId,
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: {
      eventType: parsed.eventType,
      action: parsed.action,
      deliveryId: parsed.deliveryId,
      repoFullName: parsed.repoFullName,
      sender: parsed.sender,
      template,
      skipTriage,
      configSource: 'workflow-md',
    },
    intent,
    entities: {
      repo: parsed.repoFullName,
      branch: parsed.branch ?? undefined,
      prNumber: parsed.prNumber ?? undefined,
      issueNumber: parsed.issueNumber ?? undefined,
      files: parsed.files.length > 0 ? parsed.files : undefined,
      labels: parsed.labels.length > 0 ? parsed.labels : undefined,
      author: parsed.sender,
      severity: templateToSeverity(template),
    },
  };

  if (parsed.commentBody) {
    intakeEvent.rawText = sanitize(parsed.commentBody);
  }

  return intakeEvent;
}
