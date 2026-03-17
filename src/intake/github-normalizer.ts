/**
 * GitHub event normalizer.
 *
 * Transforms parsed GitHub events into canonical IntakeEvents
 * using the routing table from config/github-routing.json (Appendix A).
 *
 * Implements bot loop prevention by checking sender type.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IntakeEvent, WorkIntent } from '../types';
import type { ParsedGitHubEvent } from '../webhook-gateway/event-parser';

// ---------------------------------------------------------------------------
// Routing table types
// ---------------------------------------------------------------------------

export interface RoutingRule {
  event: string;
  action: string | null;
  condition: string | null;
  intent: string;
  template: string;
  phases: string[];
  priority: 'P0-immediate' | 'P1-high' | 'P2-standard' | 'P3-backlog';
  skipTriage: boolean;
}

// ---------------------------------------------------------------------------
// Load routing table
// ---------------------------------------------------------------------------

let _routingTable: RoutingRule[] | undefined;

function getRoutingTable(): RoutingRule[] {
  if (!_routingTable) {
    const filePath = resolve(__dirname, '..', '..', 'config', 'github-routing.json');
    const raw = readFileSync(filePath, 'utf-8');
    _routingTable = JSON.parse(raw) as RoutingRule[];
  }
  return _routingTable;
}

/**
 * Override the routing table (for testing).
 */
export function setRoutingTable(rules: RoutingRule[]): void {
  _routingTable = rules;
}

/**
 * Reset the routing table to force reload from disk.
 */
export function resetRoutingTable(): void {
  _routingTable = undefined;
}

// ---------------------------------------------------------------------------
// Bot user ID for loop prevention
// ---------------------------------------------------------------------------

let _botUserId: number = 0;
let _botUsername: string = '';

/**
 * Set the bot user ID for loop prevention.
 * Events from this sender ID will be skipped.
 */
export function setBotUserId(id: number): void {
  _botUserId = id;
}

/**
 * Set the bot username for loop prevention.
 * Events from this sender will be skipped, and mentions_bot
 * will only match comments containing @username.
 */
export function setBotUsername(name: string): void {
  _botUsername = name;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a parsed GitHub event into an IntakeEvent.
 *
 * Returns null if:
 * - The sender is the bot (loop prevention)
 * - No routing rule matches the event
 *
 * @param parsed - A structured parsed GitHub event
 * @returns An IntakeEvent or null if the event should be skipped
 */
export function normalizeGitHubEvent(
  parsed: ParsedGitHubEvent,
): IntakeEvent | null {
  // Bot loop prevention
  if (_botUsername && parsed.sender === _botUsername) {
    return null;
  }
  if (_botUserId > 0 && parsed.senderId === _botUserId) {
    return null;
  }
  if (parsed.senderIsBot && _botUserId === 0) {
    return null;
  }

  const rule = findMatchingRule(parsed);
  if (!rule) {
    return null;
  }

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
      template: rule.template,
      phases: rule.phases,
      skipTriage: rule.skipTriage,
    },
    intent: rule.intent as WorkIntent,
    entities: {
      repo: parsed.repoFullName,
      branch: parsed.branch ?? undefined,
      prNumber: parsed.prNumber ?? undefined,
      issueNumber: parsed.issueNumber ?? undefined,
      files: parsed.files.length > 0 ? parsed.files : undefined,
      labels: parsed.labels.length > 0 ? parsed.labels : undefined,
      author: parsed.sender,
      severity: priorityToSeverity(rule.priority),
    },
  };

  if (parsed.commentBody) {
    intakeEvent.rawText = parsed.commentBody;
  }

  return intakeEvent;
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

function findMatchingRule(parsed: ParsedGitHubEvent): RoutingRule | null {
  const rules = getRoutingTable();

  for (const rule of rules) {
    if (rule.event !== parsed.eventType) continue;

    // Check action match
    if (rule.action !== null && rule.action !== parsed.action) continue;

    // Check condition
    if (rule.condition !== null && !matchesCondition(rule, parsed)) continue;

    return rule;
  }

  return null;
}

function matchesCondition(rule: RoutingRule, parsed: ParsedGitHubEvent): boolean {
  switch (rule.condition) {
    case 'default_branch':
      return parsed.branch === parsed.defaultBranch;

    case 'other_branch':
      return parsed.branch !== null && parsed.branch !== parsed.defaultBranch;

    case 'merged':
      return parsed.merged === true;

    case 'bug':
      return parsed.labels.includes('bug');

    case 'enhancement':
      return parsed.labels.includes('enhancement');

    case 'mentions_bot':
      if (!parsed.commentBody) return false;
      if (_botUsername) return parsed.commentBody.includes(`@${_botUsername}`);
      return true;

    case 'changes_requested':
      return parsed.reviewState === 'changes_requested';

    case 'failure':
      return parsed.conclusion === 'failure';

    default:
      return false;
  }
}

function priorityToSeverity(
  priority: string,
): 'low' | 'medium' | 'high' | 'critical' {
  switch (priority) {
    case 'P0-immediate':
      return 'critical';
    case 'P1-high':
      return 'high';
    case 'P2-standard':
      return 'medium';
    case 'P3-backlog':
      return 'low';
    default:
      return 'medium';
  }
}
