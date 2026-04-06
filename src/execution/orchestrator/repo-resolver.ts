/**
 * Phase 8: Multi-Repository Workspace Resolution.
 *
 * Resolves which repository to use for a given Linear issue based on:
 * 1. Label match (case-insensitive intersection)
 * 2. Team key match (case-insensitive)
 * 3. issueRepositorySuggestions API (Linear AI ranking)
 * 4. Select signal user prompt (low confidence)
 * 5. Default repo fallback
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { LinearClient, LinearIssueResponse } from '../../integration/linear/linear-client';
import type { RepoConfig, WorkspaceConfig } from '../../integration/linear/workflow-parser';
import { emitSelectElicitation } from './issue-worker-runner';

export type { RepoConfig, WorkspaceConfig };

// ---------------------------------------------------------------------------
// Resolution result types
// ---------------------------------------------------------------------------

export type RepoResolutionResult =
  | { status: 'resolved'; repo: RepoConfig }
  | { status: 'pending' };

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

const AUTO_SELECT_CONFIDENCE_THRESHOLD = 0.8;

export async function resolveRepoForIssue(
  issue: LinearIssueResponse,
  workspaceConfig: WorkspaceConfig,
  linearClient?: LinearClient,
  agentSessionId?: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<RepoResolutionResult> {
  const { repos } = workspaceConfig;

  if (!repos || repos.length === 0) {
    throw new Error('workspace.repos is required and must be a non-empty array');
  }

  // 1. Label match (highest priority — explicit routing)
  const issueLabels = issue.labels.nodes.map((l) => l.name.toLowerCase());
  for (const repo of repos) {
    if (!repo.labels || repo.labels.length === 0) continue;
    const repoLabels = repo.labels.map((l) => l.toLowerCase());
    const hasMatch = issueLabels.some((il) => repoLabels.includes(il));
    if (hasMatch) {
      return { status: 'resolved', repo };
    }
  }

  // 2. Team key match
  const issueTeamKey = issue.team?.key?.toLowerCase();
  if (issueTeamKey) {
    for (const repo of repos) {
      if (!repo.teams || repo.teams.length === 0) continue;
      const repoTeams = repo.teams.map((t) => t.toLowerCase());
      if (repoTeams.includes(issueTeamKey)) {
        return { status: 'resolved', repo };
      }
    }
  }

  // 3. issueRepositorySuggestions API (Linear AI ranking)
  if (linearClient && agentSessionId) {
    try {
      const candidates = repos.map((r) => ({
        hostname: 'github.com',
        repositoryFullName: extractFullName(r.url),
      }));

      const suggestions = await linearClient.issueRepositorySuggestions(
        issue.id, agentSessionId, candidates,
      );

      if (suggestions.length > 0) {
        const sorted = [...suggestions].sort((a, b) => b.confidence - a.confidence);
        const best = sorted[0];

        if (best.confidence > AUTO_SELECT_CONFIDENCE_THRESHOLD) {
          const matched = repos.find(
            (r) => extractFullName(r.url) === best.repositoryFullName,
          );
          if (matched) {
            return { status: 'resolved', repo: matched };
          }
        }

        // 4. Select signal — ask user (low confidence)
        await emitSelectElicitation(
          linearClient,
          agentSessionId,
          'Which repository should I work in for this issue?',
          sorted.map((s) => ({
            label: s.repositoryFullName.split('/').pop() ?? s.repositoryFullName,
            value: s.repositoryFullName,
          })),
          logger,
        );
        return { status: 'pending' };
      }
    } catch (err) {
      logger?.warn('issueRepositorySuggestions failed, falling back', {
        issueId: issue.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. Fallback to default repo from config
  if (workspaceConfig.defaultRepo) {
    const defaultRepo = repos.find((r) => r.name === workspaceConfig.defaultRepo);
    if (defaultRepo) {
      return { status: 'resolved', repo: defaultRepo };
    }
  }

  throw new Error(
    `No repo resolved for issue ${issue.identifier} — check workspace.repos config`,
  );
}

// ---------------------------------------------------------------------------
// Git URL helpers
// ---------------------------------------------------------------------------

/**
 * Extract "owner/repo" from a git SSH or HTTPS URL.
 *
 * Handles:
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo
 */
export function extractFullName(url: string): string {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = url.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return httpsMatch[1];
  }
  return url;
}

// ---------------------------------------------------------------------------
// Clone management with mutex
// ---------------------------------------------------------------------------

const cloneLocks = new Map<string, Promise<string>>();

/**
 * Ensure a repo is cloned at the given path. If already cloned, fetch latest.
 * Uses a mutex to prevent concurrent clones of the same repo.
 */
export async function ensureRepoCloned(
  repoUrl: string,
  clonePath: string,
  logger?: { info?: (msg: string, meta?: Record<string, unknown>) => void; warn?: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<string> {
  const existing = cloneLocks.get(clonePath);
  if (existing) {
    return existing;
  }

  const operation = doCloneOrFetch(repoUrl, clonePath, logger);
  cloneLocks.set(clonePath, operation);

  try {
    return await operation;
  } finally {
    cloneLocks.delete(clonePath);
  }
}

async function doCloneOrFetch(
  repoUrl: string,
  clonePath: string,
  logger?: { info?: (msg: string, meta?: Record<string, unknown>) => void; warn?: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<string> {
  if (existsSync(joinPath(clonePath, '.git'))) {
    logger?.info?.('Fetching latest for existing clone', { clonePath });
    execFileSync('git', ['fetch', 'origin'], { cwd: clonePath, stdio: 'pipe' });
    return clonePath;
  }

  logger?.info?.('Cloning repository', { repoUrl, clonePath });
  execFileSync('git', ['clone', repoUrl, clonePath], { stdio: 'pipe' });
  return clonePath;
}

// ---------------------------------------------------------------------------
// Workspace path helpers
// ---------------------------------------------------------------------------

/**
 * Get the clone path for a repo within the workspace root.
 */
export function getRepoClonePath(workspaceRoot: string, repoName: string): string {
  if (repoName.includes('..') || repoName.startsWith('/')) {
    throw new Error(`Invalid repo name: ${repoName}`);
  }
  return joinPath(workspaceRoot, 'repos', repoName);
}

/**
 * Get the worktree path for an issue within the workspace root.
 */
export function getIssueWorktreePath(workspaceRoot: string, issueId: string): string {
  return joinPath(workspaceRoot, 'issues', issueId);
}
