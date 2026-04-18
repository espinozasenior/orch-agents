/**
 * Linear event normalizer.
 *
 * Transforms Linear webhook payloads into canonical IntakeEvents
 * using the WorkflowConfig from WORKFLOW.md.
 *
 * Routes issues by matching labels against the workflow routing map.
 * Filters by active/terminal states defined in WORKFLOW.md.
 *
 * Implements bot loop prevention by checking actor ID against linearBotUserId.
 * Pure function -- no I/O.
 */

import { randomUUID } from 'node:crypto';
import type { IntakeEvent } from '../../types';
import { linearIssueId } from '../../kernel/branded-types';
import { sanitize } from '../../shared/input-sanitizer';
import type { LinearWebhookPayload } from './types';
import type { WorkflowConfig } from '../../config';

// ---------------------------------------------------------------------------
// Default workflow config (used when no WORKFLOW.md is loaded)
// ---------------------------------------------------------------------------

const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  repos: {},
  defaults: {
    agents: { maxConcurrentPerOrg: 8 },
    stall: { timeoutMs: 300_000 },
    polling: { intervalMs: 30_000, enabled: false },
  },
  tracker: {
    kind: 'linear',
    apiKey: '',
    team: '',
    activeTypes: ['unstarted', 'started'],
    terminalTypes: ['completed', 'canceled'],
    activeStates: [],
    terminalStates: [],
  },
  agents: {
    maxConcurrent: 8,
  },
  agent: {
    maxConcurrentAgents: 8,
    maxRetryBackoffMs: 300_000,
    maxTurns: 20,
  },
  polling: { intervalMs: 30_000, enabled: false },
  stall: { timeoutMs: 300_000 },
  agentRunner: {
    stallTimeoutMs: 300_000,
    command: 'claude',
    turnTimeoutMs: 3_600_000,
  },
  hooks: {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 60_000,
  },
  promptTemplate: '',
};

let _workflowConfig: WorkflowConfig = DEFAULT_WORKFLOW_CONFIG;

/**
 * Set the workflow config (from parsed WORKFLOW.md or for testing).
 */
export function setWorkflowConfig(config: WorkflowConfig): void {
  _workflowConfig = config;
}

/**
 * Reset the workflow config to the built-in default.
 */
export function resetWorkflowConfig(): void {
  _workflowConfig = DEFAULT_WORKFLOW_CONFIG;
}

/**
 * Get the current workflow config.
 */
export function getWorkflowConfig(): WorkflowConfig {
  return _workflowConfig;
}

// ---------------------------------------------------------------------------
// Bot user ID for loop prevention
// TODO: Refactor to use config injection instead of module-level state.
//       Both this file and github-workflow-normalizer.ts maintain separate
//       bot identity state with setter functions. A shared BotIdentity config
//       object should be injected via the factory/normalizer call instead.
//       (Low priority)
// ---------------------------------------------------------------------------

let _botUserId = '';

/**
 * Set the bot user ID for loop prevention.
 * Events from this actor will be skipped.
 */
export function setLinearBotUserId(id: string): void {
  _botUserId = id;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a Linear webhook payload into an IntakeEvent.
 *
 * Returns null if:
 * - The actor is the bot (loop prevention)
 * - The event type is not 'Issue'
 * - The issue is in a terminal state
 * - The issue is not in an active state and no label matches routing
 *
 * @param payload - A Linear webhook payload
 * @param updatedFrom - Previous field values (from payload.updatedFrom)
 * @param config - Optional config overrides (botUserId, defaultRepo)
 * @returns An IntakeEvent or null if the event should be skipped
 */
export function normalizeLinearEvent(
  payload: LinearWebhookPayload,
  updatedFrom?: Record<string, unknown>,
  config?: { linearBotUserId?: string; defaultRepo?: string },
): IntakeEvent | null {
  // Only handle Issue events
  if (payload.type !== 'Issue') {
    return null;
  }

  if (!payload.data) return null;

  const issue = payload.data;
  const botId = config?.linearBotUserId || _botUserId;

  // Bot loop prevention: skip if actor is the bot
  if (botId && payload.actor?.id === botId) {
    return null;
  }

  const fields = updatedFrom ?? payload.updatedFrom ?? {};
  const wf = _workflowConfig;

  // Check if anything actually changed that we care about
  // Linear sends "stateId" (not "state") and "assigneeId" in updatedFrom
  const stateChanged = fields.state !== undefined || fields.stateId !== undefined;
  const labelsChanged = fields.labelIds !== undefined;
  const assigneeChanged = fields.assigneeId !== undefined;
  const priorityChanged = fields.priority !== undefined;

  if (!stateChanged && !labelsChanged && !assigneeChanged && !priorityChanged) {
    return null;
  }

  // Terminal state check — prefer type-based matching (resilient to name changes)
  const currentStateType = issue.state?.type?.toLowerCase();
  const currentStateName = issue.state?.name?.toLowerCase();
  if (currentStateType) {
    if ((wf.tracker?.terminalTypes ?? []).includes(currentStateType as never)) {
      return null;
    }
  } else if (currentStateName) {
    // Fallback: match by name when type is unavailable
    const terminalStates = (wf.tracker?.terminalStates ?? []).map((s) => s.toLowerCase());
    if (terminalStates.includes(currentStateName)) {
      return null;
    }
  }

  // Categorize by label for observability metadata
  const category = findCategoryByLabels(issue.labels);

  // Determine intent label (kept as a sourceMetadata string for observability)
  const intent = buildIntent(category, issue, fields);

  // Check if we should process: active state or label/assignee/priority change
  if (stateChanged) {
    if (currentStateType) {
      // Prefer type-based matching
      if (!(wf.tracker?.activeTypes ?? []).includes(currentStateType as never)) {
        return null;
      }
    } else if (currentStateName) {
      // Fallback: match by name when type is unavailable
      const activeStates = (wf.tracker?.activeStates ?? []).map((s) => s.toLowerCase());
      if (!activeStates.includes(currentStateName)) {
        return null;
      }
    }
  }

  const intakeEvent: IntakeEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: 'linear',
    sourceMetadata: {
      source: 'linear',
      linearIssueId: linearIssueId(issue.id),
      linearTeamKey: issue.team?.key,
      linearIdentifier: issue.identifier,
      linearUrl: issue.url,
      category,
      previousState: fields,
      intent,
    },
    entities: {
      repo: findGitHubRepo(issue) ?? config?.defaultRepo,
      labels: issue.labels?.map((l) => l.name),
      author: issue.creator?.name,
      severity: deriveSeverity(issue, category),
      requirementId: issue.identifier,
      projectId: issue.project?.id,
    },
    rawText: sanitize(issue.description ?? ''),
  };

  return intakeEvent;
}

// ---------------------------------------------------------------------------
// Label-based routing
// ---------------------------------------------------------------------------

const KNOWN_CATEGORIES = new Set(['bug', 'feature', 'security', 'refactor']);

function findCategoryByLabels(
  labels: LinearWebhookPayload['data']['labels'],
): string {
  if (!labels) return 'general';
  for (const label of labels) {
    const name = label.name.toLowerCase();
    if (KNOWN_CATEGORIES.has(name)) return name;
  }
  return 'general';
}

// ---------------------------------------------------------------------------
// Intent builder
// ---------------------------------------------------------------------------

function buildIntent(
  category: string,
  issue: LinearWebhookPayload['data'],
  fields: Record<string, unknown>,
): string {
  // Map category names to descriptive intents
  const labelsChanged = fields.labelIds !== undefined;
  const assigneeChanged = fields.assigneeId !== undefined;
  const priorityChanged = fields.priority !== undefined;
  // Linear sends "stateId" (not "state") in updatedFrom — check both for compat
  const stateChanged = fields.state !== undefined || fields.stateId !== undefined;

  // Label-based intents
  if (labelsChanged && issue.labels) {
    for (const label of issue.labels) {
      const name = label.name.toLowerCase();
      if (name === 'bug') return 'custom:linear-bug';
      if (name === 'feature') return 'custom:linear-feature';
      if (name === 'security') return 'custom:linear-security';
      if (name === 'refactor') return 'custom:linear-refactor';
    }
  }

  // Priority-based intent
  if (priorityChanged && issue.priority <= 1) {
    return 'custom:linear-urgent';
  }

  // Assignee-based intent
  if (assigneeChanged) {
    return 'custom:linear-assigned';
  }

  // State-based intents — match by type, resilient to display name changes
  if (stateChanged && issue.state) {
    const stateType = issue.state.type?.toLowerCase();
    if (stateType) {
      if (stateType === 'unstarted') return 'custom:linear-todo';
      if (stateType === 'started') return 'custom:linear-start';
      return `custom:linear-${stateType}`;
    }
    // Fallback: type unavailable — derive intent from name as last resort
    return `custom:linear-${issue.state.name.toLowerCase().replace(/\s+/g, '-')}`;
  }

  return `custom:linear-${category}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findGitHubRepo(issue: LinearWebhookPayload['data']): string | undefined {
  if (!issue.attachments) return undefined;
  const ghAttachment = issue.attachments.find((a) => a.sourceType === 'github');
  return ghAttachment?.url;
}

function deriveSeverity(
  issue: LinearWebhookPayload['data'],
  category: string,
): 'low' | 'medium' | 'high' | 'critical' {
  // Security category is always critical
  if (category === 'security') return 'critical';

  // Map Linear priority to severity
  if (issue.priority <= 1) return 'critical';
  if (issue.priority === 2) return 'high';
  if (issue.priority === 3) return 'medium';
  return 'low';
}
