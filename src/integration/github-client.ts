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
import { buildSafeEnv } from '../shared/safe-env';
import type { GitHubTokenProvider } from './github-app-auth';

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
  /** Push a branch from a worktree to remote. Supports refspec for cross-branch push. */
  pushBranch(worktreePath: string, branch: string, opts?: PushOpts): Promise<void>;
  /** Submit a review (approve or request changes). */
  submitReview(
    repo: string,
    prNumber: number,
    verdict: 'APPROVE' | 'REQUEST_CHANGES',
    body: string,
  ): Promise<void>;
  /** P20: Read PR view (`gh pr view`). */
  prView(repoFullName: string, prNumber: number): Promise<string>;
  /** P20: Read PR diff (`gh pr diff`). */
  prDiff(repoFullName: string, prNumber: number): Promise<string>;
  /** P20: Read issue view (`gh issue view`). */
  issueView(repoFullName: string, issueNumber: number): Promise<string>;
  /** P20: Read PR checks (`gh pr checks`). */
  prChecks(repoFullName: string, prNumber: number): Promise<string>;
}

export interface PushOpts {
  /** Remote branch name (if different from local branch). Uses refspec push. */
  remoteBranch?: string;
  /** Repository slug (owner/name). Required when using token-authenticated HTTPS push. */
  repo?: string;
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
  /** GitHub App token provider. If set, takes precedence over static token. */
  tokenProvider?: GitHubTokenProvider;
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

  async function getEffectiveToken(): Promise<string | undefined> {
    if (deps.tokenProvider) return deps.tokenProvider.getToken();
    return deps.token;
  }

  async function run(
    command: string,
    args: string[],
    opts?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      log?.debug('github-client exec', { command, args });
      if (deps.exec) {
        return await deps.exec(command, args, opts);
      }
      const token = await getEffectiveToken();
      return await execFileAsync(command, args, {
        timeout: 30_000,
        cwd: opts?.cwd,
        env: {
          ...buildSafeEnv(),
          ...(token ? { GH_TOKEN: token } : {}),
        },
      });
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

    async pushBranch(worktreePath, branch, opts?) {
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

      const remoteBranch = opts?.remoteBranch;
      const repo = opts?.repo;

      // Token-authenticated HTTPS push with refspec
      if (remoteBranch) {
        const refspec = `HEAD:refs/heads/${remoteBranch}`;
        const token = await getEffectiveToken();

        if (token && repo) {
          // Push via token-embedded URL (works regardless of remote format)
          const tokenUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
          log?.debug('Pushing with refspec (token auth)', { worktreePath, refspec });
          try {
            await execFileAsync('git', ['-C', worktreePath, 'push', tokenUrl, refspec], {
              timeout: 30_000,
              env: { ...buildSafeEnv() },
            });
          } catch (err) {
            // Redact token from error messages to prevent leaking to logs
            const message = err instanceof Error ? err.message : String(err);
            const redacted = message.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
            throw new ExecutionError(`Git push failed: ${redacted}`, { cause: err });
          }
        } else {
          log?.debug('Pushing with refspec (origin)', { worktreePath, refspec });
          await run('git', ['-C', worktreePath, 'push', 'origin', refspec]);
        }
      } else {
        await run('git', ['-C', worktreePath, 'push', '-u', 'origin', branch]);
      }
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

    // P20: Read methods used by context-fetchers.

    async prView(repoFullName, prNumber) {
      validateRepo(repoFullName);
      validatePRNumber(prNumber);
      const { stdout } = await run('gh', [
        'pr', 'view', String(prNumber),
        '--repo', repoFullName,
      ]);
      return stdout;
    },

    async prDiff(repoFullName, prNumber) {
      validateRepo(repoFullName);
      validatePRNumber(prNumber);
      const { stdout } = await run('gh', [
        'pr', 'diff', String(prNumber),
        '--repo', repoFullName,
      ]);
      return stdout;
    },

    async issueView(repoFullName, issueNumber) {
      validateRepo(repoFullName);
      validatePRNumber(issueNumber);
      const { stdout } = await run('gh', [
        'issue', 'view', String(issueNumber),
        '--repo', repoFullName,
      ]);
      return stdout;
    },

    async prChecks(repoFullName, prNumber) {
      validateRepo(repoFullName);
      validatePRNumber(prNumber);
      const { stdout } = await run('gh', [
        'pr', 'checks', String(prNumber),
        '--repo', repoFullName,
      ]);
      return stdout;
    },
  };
}
