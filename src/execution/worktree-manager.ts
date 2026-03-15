/**
 * Worktree Manager — manages git worktrees for isolated agent execution.
 *
 * Each plan gets its own worktree under basePath/<planId>, ensuring agents
 * never modify the main working tree. Factory-DI pattern, London School TDD.
 */

import { execFile as execFileCb } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeHandle } from '../types';
import type { Logger } from '../shared/logger';
import { ValidationError, ExecutionError } from '../shared/errors';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorktreeManager {
  create(planId: string, baseBranch: string, workBranch: string): Promise<WorktreeHandle>;
  commit(handle: WorktreeHandle, message: string): Promise<string>;
  push(handle: WorktreeHandle): Promise<void>;
  diff(handle: WorktreeHandle): Promise<string>;
  dispose(handle: WorktreeHandle): Promise<void>;
}

export interface WorktreeManagerDeps {
  logger?: Logger;
  basePath?: string;
  /** Injected exec for testing. Defaults to promisified child_process.execFile. */
  exec?: typeof execFile;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- intentional null-byte check for path traversal prevention
const PATH_TRAVERSAL_RE = /\.\.|^\/|[\x00]/;

function validatePlanId(planId: string): void {
  if (!planId || PATH_TRAVERSAL_RE.test(planId)) {
    throw new ValidationError(
      `Invalid planId: "${planId}" — must not contain path traversal characters`,
      { planId: 'Must be a simple identifier without ../ or absolute paths' },
    );
  }
}

/**
 * Validate a git branch name to prevent argument injection and invalid refs.
 *
 * Rejects:
 * - empty strings
 * - strings containing `..`, null bytes, spaces, `~`, `^`, `:`, `?`, `*`, `[`, `\`
 * - strings starting with `-` (prevents argument injection)
 * - strings starting with `/` or ending with `/`, `.lock`, or `.`
 */
// eslint-disable-next-line no-control-regex -- intentional null-byte and DEL check for git ref validation
const BRANCH_INVALID_CHARS_RE = /[\x00 ~^:?*[\\\x7f]/;

function validateBranchName(name: string, label: string): void {
  if (!name) {
    throw new ValidationError(
      `Invalid branch name for ${label}: must not be empty`,
      { [label]: 'Must be a non-empty git branch name' },
    );
  }
  if (name.startsWith('-')) {
    throw new ValidationError(
      `Invalid branch name for ${label}: "${name}" — must not start with "-" (prevents argument injection)`,
      { [label]: 'Must not start with "-"' },
    );
  }
  if (name.startsWith('/')) {
    throw new ValidationError(
      `Invalid branch name for ${label}: "${name}" — must not start with "/"`,
      { [label]: 'Must not start with "/"' },
    );
  }
  if (name.endsWith('/') || name.endsWith('.lock') || name.endsWith('.')) {
    throw new ValidationError(
      `Invalid branch name for ${label}: "${name}" — must not end with "/", ".lock", or "."`,
      { [label]: 'Must not end with "/", ".lock", or "."' },
    );
  }
  if (name.includes('..')) {
    throw new ValidationError(
      `Invalid branch name for ${label}: "${name}" — must not contain ".."`,
      { [label]: 'Must not contain ".."' },
    );
  }
  if (BRANCH_INVALID_CHARS_RE.test(name)) {
    throw new ValidationError(
      `Invalid branch name for ${label}: "${name}" — contains invalid characters`,
      { [label]: 'Must not contain spaces, ~, ^, :, ?, *, [, or backslash' },
    );
  }
}

/**
 * Extract a commit SHA from `git commit` output.
 * Typical output: "[branch abc1234] commit message"
 */
function extractSha(stdout: string): string {
  const match = stdout.match(/\[[\w/.-]+\s+([0-9a-f]{7,40})\]/);
  return match?.[1] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_BASE_PATH = '/tmp/orch-agents';

/**
 * Create a WorktreeManager that manages git worktree lifecycle via child_process.
 */
export function createWorktreeManager(deps: WorktreeManagerDeps = {}): WorktreeManager {
  const {
    logger,
    basePath = DEFAULT_BASE_PATH,
    exec: run = execFile,
  } = deps;

  return {
    async create(planId: string, baseBranch: string, workBranch: string): Promise<WorktreeHandle> {
      validatePlanId(planId);
      validateBranchName(baseBranch, 'baseBranch');
      validateBranchName(workBranch, 'workBranch');

      const worktreePath = `${basePath}/${planId}`;
      logger?.info('Creating worktree', { planId, baseBranch, workBranch, path: worktreePath });

      try {
        await run('git', ['worktree', 'add', worktreePath, '-b', workBranch, baseBranch]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error('Failed to create worktree', { planId, error: message });
        throw new ExecutionError(`Worktree create failed: ${message}`, { cause: err });
      }

      const handle: WorktreeHandle = {
        planId,
        path: worktreePath,
        branch: workBranch,
        baseBranch,
        status: 'active',
      };

      logger?.info('Worktree created', { planId, path: worktreePath, branch: workBranch });
      return handle;
    },

    async commit(handle: WorktreeHandle, message: string): Promise<string> {
      logger?.info('Committing changes', { planId: handle.planId, path: handle.path });

      try {
        await run('git', ['-C', handle.path, 'add', '-A']);
        const { stdout } = await run('git', ['-C', handle.path, 'commit', '-m', message]);
        const sha = extractSha(stdout);
        handle.status = 'committed';
        logger?.info('Changes committed', { planId: handle.planId, sha });
        return sha;
      } catch (err) {
        const message_ = err instanceof Error ? err.message : String(err);
        // Check for "nothing to commit" scenario
        if (message_.includes('nothing to commit')) {
          logger?.warn('Nothing to commit', { planId: handle.planId });
          throw new ExecutionError('Nothing to commit', { cause: err });
        }
        logger?.error('Commit failed', { planId: handle.planId, error: message_ });
        throw new ExecutionError(`Commit failed: ${message_}`, { cause: err });
      }
    },

    async push(handle: WorktreeHandle): Promise<void> {
      logger?.info('Pushing branch', { planId: handle.planId, branch: handle.branch });

      try {
        await run('git', ['-C', handle.path, 'push', '-u', 'origin', handle.branch]);
        handle.status = 'pushed';
        logger?.info('Branch pushed', { planId: handle.planId, branch: handle.branch });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error('Push failed', { planId: handle.planId, error: message });
        throw new ExecutionError(`Push failed: ${message}`, { cause: err });
      }
    },

    async diff(handle: WorktreeHandle): Promise<string> {
      logger?.debug('Getting diff', { planId: handle.planId });

      try {
        const { stdout } = await run('git', ['-C', handle.path, 'diff', 'HEAD']);
        // If no unstaged changes, try staged diff
        if (!stdout.trim()) {
          const { stdout: stagedOut } = await run('git', ['-C', handle.path, 'diff', '--cached']);
          return stagedOut;
        }
        return stdout;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error('Diff failed', { planId: handle.planId, error: message });
        throw new ExecutionError(`Diff failed: ${message}`, { cause: err });
      }
    },

    async dispose(handle: WorktreeHandle): Promise<void> {
      logger?.info('Disposing worktree', { planId: handle.planId, path: handle.path });

      // SECURITY: Verify path is within basePath before any destructive operations
      const resolvedPath = pathResolve(handle.path);
      const resolvedBase = pathResolve(basePath);
      if (!resolvedPath.startsWith(resolvedBase + '/') || resolvedPath === resolvedBase) {
        logger?.error('Refusing to dispose path outside basePath', {
          path: resolvedPath,
          basePath: resolvedBase,
        });
        throw new ValidationError(
          `Worktree path "${resolvedPath}" is not within basePath "${resolvedBase}"`,
          { path: 'Must be a subdirectory of basePath' },
        );
      }

      try {
        await run('git', ['worktree', 'remove', handle.path, '--force']);
      } catch (err) {
        logger?.warn('Worktree remove failed, falling back to rm -rf', {
          planId: handle.planId,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          await run('rm', ['-rf', handle.path]);
        } catch (rmErr) {
          logger?.error('rm -rf fallback also failed', {
            planId: handle.planId,
            error: rmErr instanceof Error ? rmErr.message : String(rmErr),
          });
        }
      }

      handle.status = 'disposed';
      logger?.info('Worktree disposed', { planId: handle.planId });
    },
  };
}
