/**
 * P20: Skill Resolver.
 *
 * Resolves a webhook event to a skill markdown file (path + frontmatter + body).
 * Routing source of truth: WORKFLOW.md `github.events`. Explicit-only — unmapped
 * events return null (no default / catch-all). Path is the identifier — no name
 * indexing, no registry, no caching.
 *
 * - `resolvePath` is pure (no I/O); used by the normalizer.
 * - `resolveByPath` performs a single readFileSync; used by execution-engine.
 * - `resolveSkillForEvent` is the convenience composition of both.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ParsedGitHubEvent } from '../webhook-gateway/event-parser';
import type { WorkflowConfig } from '../config';
import {
  parseSkillFile,
  type AgentFrontmatter,
} from './frontmatter-parser';

// ---------------------------------------------------------------------------
// Rule key parsing (ported from github-workflow-normalizer.ts — FR-P20-003)
// ---------------------------------------------------------------------------

/**
 * Known event types that have standard GitHub actions.
 */
export const KNOWN_ACTION_EVENTS: Record<string, string[]> = {
  pull_request: ['opened', 'synchronize', 'closed', 'ready_for_review', 'review_requested'],
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

  const event = parts[0];
  const remaining = parts.slice(1);

  if (remaining.length === 0) {
    return { event, action: null, condition: null };
  }

  if (remaining.length === 1) {
    const segment = remaining[0];
    if (event in KNOWN_ACTION_EVENTS && KNOWN_ACTION_EVENTS[event].includes(segment)) {
      return { event, action: segment, condition: null };
    }
    return { event, action: null, condition: segment };
  }

  if (remaining.length === 2) {
    return { event, action: remaining[0], condition: remaining[1] };
  }

  return { event, action: remaining[0], condition: remaining.slice(1).join('.') };
}

/**
 * Build the canonical rule key for a parsed GitHub event. Used by the
 * normalizer to look up the routing path in `github.events`.
 *
 * Strategy: produce the most specific key first (event.action.condition),
 * then event.action, then event.condition, then event. The resolver tries
 * keys in that order.
 */
export function buildRuleKeyCandidates(parsed: ParsedGitHubEvent): string[] {
  const candidates: string[] = [];
  const { eventType, action } = parsed;

  // Build implicit conditions from the parsed event.
  const conditions: string[] = [];
  if (parsed.merged) conditions.push('merged');
  if (parsed.reviewState === 'changes_requested') conditions.push('changes_requested');
  if (parsed.conclusion === 'failure') conditions.push('failure');
  if (parsed.branch !== null && parsed.branch === parsed.defaultBranch) {
    conditions.push('default_branch');
  } else if (parsed.branch !== null && parsed.branch !== parsed.defaultBranch) {
    conditions.push('other');
  }
  for (const label of parsed.labels) {
    conditions.push(label);
  }

  // event.action.condition (most specific)
  if (action) {
    for (const c of conditions) {
      candidates.push(`${eventType}.${action}.${c}`);
    }
    candidates.push(`${eventType}.${action}`);
  }
  // event.condition
  for (const c of conditions) {
    candidates.push(`${eventType}.${c}`);
  }
  // event
  candidates.push(eventType);

  return candidates;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolvedSkill {
  /** Absolute path to the skill file. */
  path: string;
  frontmatter: AgentFrontmatter;
  body: string;
}

export interface SkillResolver {
  /**
   * Pure: looks up the relative path the parsed event resolves to. Returns
   * `{ relPath, ruleKey }` or null when no rule (and no default) matches.
   */
  resolvePath(
    parsed: ParsedGitHubEvent,
    config: WorkflowConfig,
  ): { relPath: string; ruleKey: string } | null;

  /**
   * Single readFileSync + parseFrontmatter. Returns null if the file is
   * missing or has no frontmatter.
   */
  resolveByPath(relPath: string, repoRoot: string): ResolvedSkill | null;

  /**
   * Convenience: resolvePath + resolveByPath in one call.
   */
  resolveSkillForEvent(
    parsed: ParsedGitHubEvent,
    config: WorkflowConfig,
    repoRoot: string,
  ): ResolvedSkill | null;
}

/**
 * Pure path lookup — no I/O. Explicit routes only: returns null when no
 * WORKFLOW.md `github.events` entry matches. The operator decides what flows
 * through the pipeline by editing the events map; anything else is silently
 * ignored at the normalizer layer (no IntakeEvent, no worktree, no coordinator
 * cycle). No default / catch-all fallback by design.
 */
export function resolvePath(
  parsed: ParsedGitHubEvent,
  config: WorkflowConfig,
): { relPath: string; ruleKey: string } | null {
  const events = config.github?.events ?? {};
  const candidates = buildRuleKeyCandidates(parsed);
  for (const ruleKey of candidates) {
    const relPath = events[ruleKey];
    if (typeof relPath === 'string' && relPath.length > 0) {
      return { relPath, ruleKey };
    }
  }
  return null;
}

/** Single readFileSync + parseFrontmatter. */
export function resolveByPath(relPath: string, repoRoot: string): ResolvedSkill | null {
  const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(repoRoot, relPath);
  if (!existsSync(absPath)) return null;
  const raw = readFileSync(absPath, 'utf8');
  const parsed = parseSkillFile(raw);
  if (!parsed) return null;
  return { path: absPath, frontmatter: parsed.frontmatter, body: parsed.body };
}

export function resolveSkillForEvent(
  parsed: ParsedGitHubEvent,
  config: WorkflowConfig,
  repoRoot: string,
): ResolvedSkill | null {
  const lookup = resolvePath(parsed, config);
  if (!lookup) return null;
  return resolveByPath(lookup.relPath, repoRoot);
}

/** Factory: returns an injectable resolver bound to the helpers above. */
export function createSkillResolver(): SkillResolver {
  return {
    resolvePath,
    resolveByPath,
    resolveSkillForEvent,
  };
}
