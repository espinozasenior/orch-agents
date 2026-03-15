/**
 * GitHub Client adapter over the `gh` CLI.
 *
 * Thin wrapper for posting PR comments, inline review comments,
 * pushing branches, and submitting reviews. Uses dependency injection
 * for the command executor so tests can mock all shell interactions.
 *
 * Factory: createGitHubClient(deps?) => GitHubClient
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../shared/logger';
import { ExecutionError } from '../shared/errors';
import { buildSafeEnv } from '../execution/cli-client';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GitHubClient {
  /** Post a general comment on a PR. */
  postPRComment(repo: string, prNumber: number, body: string): Promise<void>;
  /** Post an inline review comment on a specific file/line. */
  postInlineComment(
    repo: string,
    prNumber: number,
    path: string,
    line: number,
    body: string,
    commitSha: string,
  ): Promise<void>;
  /** Push a branch from a worktree to remote. */
  pushBranch(worktreePath: string, branch: string): Promise<void>;
  /** Submit a review (approve or request changes). */
  submitReview(
    repo: string,
    prNumber: number,
    verdict: 'APPROVE' | 'REQUEST_CHANGES',
    body: string,
  ): Promise<void>;
}

export interface GitHubClientDeps {
  logger?: Logger;
  /** Injectable command executor for testing. */
  exec?: (
    command: string,
    args: string[],
    opts?: { cwd?: string },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** GitHub token. If not provided, relies on gh CLI being authenticated. */
  token?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const REPO_RE = /^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/;

function validateRepo(repo: string): void {
  if (!REPO_RE.test(repo)) {
    throw new ExecutionError(
      `Invalid repo format '${repo}'. Expected 'owner/name'.`,
    );
  }
}

function validatePRNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new ExecutionError(
      `Invalid PR number ${prNumber}. Must be a positive integer.`,
    );
  }
}

function validateBody(body: string): void {
  if (!body || body.trim().length === 0) {
    throw new ExecutionError('Comment body must not be empty.');
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGitHubClient(deps: GitHubClientDeps = {}): GitHubClient {
  const log = deps.logger;
  const exec =
    deps.exec ??
    ((command: string, args: string[], opts?: { cwd?: string }) =>
      execFileAsync(command, args, {
        timeout: 30_000,
        cwd: opts?.cwd,
        env: {
          ...buildSafeEnv(),
          ...(deps.token ? { GH_TOKEN: deps.token } : {}),
        },
      }));

  async function run(
    command: string,
    args: string[],
    opts?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      log?.debug('github-client exec', { command, args });
      return await exec(command, args, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.error('github-client exec failed', { command, args, error: message });
      throw new ExecutionError(
        `GitHub CLI command failed: ${command} ${args.slice(0, 3).join(' ')}: ${message}`,
        { cause: err },
      );
    }
  }

  return {
    async postPRComment(repo, prNumber, body) {
      validateRepo(repo);
      validatePRNumber(prNumber);
      validateBody(body);

      await run('gh', [
        'pr', 'comment', String(prNumber),
        '--repo', repo,
        '--body', body,
      ]);
    },

    async postInlineComment(repo, prNumber, path, line, body, commitSha) {
      validateRepo(repo);
      validatePRNumber(prNumber);
      validateBody(body);

      await run('gh', [
        'api', '-X', 'POST',
        `repos/${repo}/pulls/${prNumber}/comments`,
        '-f', `body=${body}`,
        '-f', `path=${path}`,
        '-F', `line=${line}`,
        '-f', 'side=RIGHT',
        '-f', `commit_id=${commitSha}`,
      ]);
    },

    async pushBranch(worktreePath, branch) {
      // M3: Validate inputs
      if (!branch || branch.startsWith('-')) {
        throw new ExecutionError(
          `Invalid branch name '${branch}'. Must be non-empty and must not start with '-'.`,
        );
      }
      if (!worktreePath || !worktreePath.startsWith('/')) {
        throw new ExecutionError(
          `Invalid worktreePath '${worktreePath}'. Must be a non-empty absolute path.`,
        );
      }
      await run('git', ['-C', worktreePath, 'push', '-u', 'origin', branch]);
    },

    async submitReview(repo, prNumber, verdict, body) {
      validateRepo(repo);
      validatePRNumber(prNumber);
      validateBody(body);

      const flag = verdict === 'APPROVE' ? '--approve' : '--request-changes';
      await run('gh', [
        'pr', 'review', String(prNumber),
        '--repo', repo,
        flag,
        '--body', body,
      ]);
    },
  };
}
