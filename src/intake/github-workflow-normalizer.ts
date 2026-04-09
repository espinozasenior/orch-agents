/**
 * GitHub event normalizer using WORKFLOW.md configuration.
 *
 * P20: shrunk to a thin shell. Routing decisions move to the skill-resolver
 * (path-based via WORKFLOW.md `github.events`); behavior moves into skill
 * markdown files. The normalizer is now responsible for:
 *   1. bot-loop / agent-commit filtering
 *   2. stamping `sourceMetadata.{skillPath, ruleKey, parsed}` so the
 *      execution-engine can fetch context per-dispatch.
 */

import type { IntakeEvent } from '../types';
import type { ParsedGitHubEvent } from '../webhook-gateway/event-parser';
import type { WorkflowConfig } from '../integration/linear/workflow-parser';
import { sanitize } from '../shared/input-sanitizer';
import { isAgentCommit } from '../shared/agent-commit-tracker';
import { createSkillResolver, type SkillResolver } from './skill-resolver';

// Re-export so existing imports keep working.
export { parseRuleKey, type ParsedRuleKey } from './skill-resolver';

// ---------------------------------------------------------------------------
// Bot identity (mirrors github-normalizer.ts).
// ---------------------------------------------------------------------------

let _botUserId = 0;
let _botUsername = '';

export function setBotUserId(id: number): void { _botUserId = id; }
export function setBotUsername(name: string): void { _botUsername = name; }

// ---------------------------------------------------------------------------
// Loop prevention
// ---------------------------------------------------------------------------

function isBotLoop(parsed: ParsedGitHubEvent, botUsername: string): boolean {
  if (botUsername && parsed.sender === botUsername) return true;
  if (_botUserId > 0 && parsed.senderId === _botUserId) return true;
  if (parsed.senderIsBot && _botUserId === 0) return true;
  return false;
}

function isAgentTriggeredPushOrSync(parsed: ParsedGitHubEvent): boolean {
  if (parsed.eventType === 'push') {
    const headCommitId = (parsed.rawPayload as { head_commit?: { id?: string } }).head_commit?.id;
    if (headCommitId && isAgentCommit(headCommitId)) return true;
  }
  if (parsed.eventType === 'pull_request' && parsed.action === 'synchronize') {
    const afterSha = (parsed.rawPayload as { after?: string }).after;
    if (afterSha && isAgentCommit(afterSha)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface GitHubNormalizerDeps {
  skillResolver?: SkillResolver;
}

export interface GitHubNormalizer {
  normalize(parsed: ParsedGitHubEvent, config: WorkflowConfig, botUsername?: string): IntakeEvent | null;
}

export function createGitHubNormalizer(deps: GitHubNormalizerDeps = {}): GitHubNormalizer {
  const skillResolver = deps.skillResolver ?? createSkillResolver();
  return {
    normalize(parsed, config, botUsername) {
      return normalizeGitHubEventFromWorkflow(parsed, config, botUsername, skillResolver);
    },
  };
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export function normalizeGitHubEventFromWorkflow(
  parsed: ParsedGitHubEvent,
  workflowConfig: WorkflowConfig,
  botUsername?: string,
  skillResolver: SkillResolver = createSkillResolver(),
): IntakeEvent | null {
  const effectiveBotUsername = botUsername ?? _botUsername;
  if (isBotLoop(parsed, effectiveBotUsername)) return null;
  if (isAgentTriggeredPushOrSync(parsed)) return null;

  // Routing source of truth: WORKFLOW.md `github.events` (+ optional default).
  const lookup = skillResolver.resolvePath(parsed, workflowConfig);
  if (!lookup) return null;

  const intakeEvent: IntakeEvent = {
    id: parsed.deliveryId,
    timestamp: new Date().toISOString(),
    source: 'github',
    sourceMetadata: {
      source: 'github',
      eventType: parsed.eventType,
      action: parsed.action,
      deliveryId: parsed.deliveryId,
      repoFullName: parsed.repoFullName,
      sender: parsed.sender,
      configSource: 'workflow-md',
      skillPath: lookup.relPath,
      ruleKey: lookup.ruleKey,
      parsed,
    },
    entities: {
      repo: parsed.repoFullName,
      branch: parsed.branch ?? undefined,
      prNumber: parsed.prNumber ?? undefined,
      issueNumber: parsed.issueNumber ?? undefined,
      files: parsed.files.length > 0 ? parsed.files : undefined,
      labels: parsed.labels.length > 0 ? parsed.labels : undefined,
      author: parsed.sender,
    },
  };

  if (parsed.commentBody) {
    intakeEvent.rawText = sanitize(parsed.commentBody);
  }

  return intakeEvent;
}
