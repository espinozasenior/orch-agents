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
import type { RepoConfig } from '../../config';
import { emitSelectElicitation } from './issue-worker-runner';

export type { RepoConfig };

// ---------------------------------------------------------------------------
// Resolution result types
// ---------------------------------------------------------------------------

export interface ResolvedRepo extends RepoConfig {
  name: string;
}

export type RepoResolutionResult =
  | { status: 'resolved'; repo: ResolvedRepo }
  | { status: 'pending' };

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

const AUTO_SELECT_CONFIDENCE_THRESHOLD = 0.8;

export async function resolveRepoForIssue(
  issue: LinearIssueResponse,
  repos: Record<string, RepoConfig>,
  linearClient?: LinearClient,
  agentSessionId?: string,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<RepoResolutionResult> {
  const repoEntries = Object.entries(repos).map(([name, config]) => ({ name, ...config }));

  if (repoEntries.length === 0) {
    throw new Error('repos is required and must be a non-empty map');
  }

  // 1. Label match (highest priority — explicit routing)
  const issueLabels = issue.labels.nodes.map((l) => l.name.toLowerCase());
  for (const entry of repoEntries) {
    if (!entry.labels || entry.labels.length === 0) continue;
    const repoLabels = entry.labels.map((l) => l.toLowerCase());
    const hasMatch = issueLabels.some((il) => repoLabels.includes(il));
    if (hasMatch) {
      return { status: 'resolved', repo: entry };
    }
  }

  // 2. Team key match
  const issueTeamKey = issue.team?.key?.toLowerCase();
  if (issueTeamKey) {
    for (const entry of repoEntries) {
      if (!entry.teams || entry.teams.length === 0) continue;
      const repoTeams = entry.teams.map((t) => t.toLowerCase());
      if (repoTeams.includes(issueTeamKey)) {
        return { status: 'resolved', repo: entry };
      }
    }
  }

  // 3. issueRepositorySuggestions API (Linear AI ranking)
  if (linearClient && agentSessionId) {
    try {
      const candidates = repoEntries.map((entry) => ({
        hostname: 'github.com',
        repositoryFullName: entry.name,
      }));

      const suggestions = await linearClient.issueRepositorySuggestions(
        issue.id, agentSessionId, candidates,
      );

      if (suggestions.length > 0) {
        const sorted = [...suggestions].sort((a, b) => b.confidence - a.confidence);
        const best = sorted[0];

        if (best.confidence > AUTO_SELECT_CONFIDENCE_THRESHOLD) {
          const matched = repoEntries.find(
            (entry) => entry.name === best.repositoryFullName,
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

  // 5. Fallback to first repo in the map
  return { status: 'resolved', repo: repoEntries[0] };
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
