/**
 * Artifact Applier — post-execution validation layer.
 *
 * After an interactive agent finishes editing files in a worktree, this
 * component inspects the git diff, validates changes are safe (no path
 * traversal, no secrets, within scope), creates a git commit, and can
 * rollback all changes on failure.
 *
 * Dependencies are injected via ArtifactApplierDeps for London School TDD.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../shared/logger';
import type { WorktreeHandle, ApplyContext, ApplyResult } from '../types';

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Re-export types for backward compatibility
// ---------------------------------------------------------------------------

export type { WorktreeHandle, ApplyContext, ApplyResult } from '../types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArtifactApplier {
  apply(planId: string, handle: WorktreeHandle, context: ApplyContext): Promise<ApplyResult>;
  rollback(handle: WorktreeHandle): Promise<void>;
}

export interface ArtifactApplierDeps {
  logger?: Logger;
  /** Run a shell command in the worktree. Injectable for testing. */
  execInWorktree?: (
    worktreePath: string,
    command: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}

// ---------------------------------------------------------------------------
// Default secret patterns
// ---------------------------------------------------------------------------

const DEFAULT_FORBIDDEN_PATTERNS: RegExp[] = [
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /(?:password|secret|token|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S{8,}/i,
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ArtifactApplier that validates and commits worktree changes.
 */
export function createArtifactApplier(deps: ArtifactApplierDeps = {}): ArtifactApplier {
  const { logger } = deps;

  const exec = deps.execInWorktree ?? defaultExecInWorktree;

  async function rollback(handle: WorktreeHandle): Promise<void> {
    logger?.info('Rolling back worktree changes', { planId: handle.planId, path: handle.path });
    await exec(handle.path, 'git', ['checkout', '--', '.']);
    await exec(handle.path, 'git', ['clean', '-fd']);
    logger?.info('Rollback complete', { planId: handle.planId });
  }

  async function apply(
    planId: string,
    handle: WorktreeHandle,
    context: ApplyContext,
  ): Promise<ApplyResult> {
    logger?.info('Applying artifacts', { planId, worktreePath: handle.path });

    // 1. Get changed files (unstaged + staged)
    const [unstaged, staged] = await Promise.all([
      exec(handle.path, 'git', ['diff', '--name-only', 'HEAD']),
      exec(handle.path, 'git', ['diff', '--name-only', '--cached']),
    ]);

    const changedFiles = dedup([
      ...splitLines(unstaged.stdout),
      ...splitLines(staged.stdout),
    ]);

    // 2. No changes — nothing to commit is OK
    if (changedFiles.length === 0) {
      logger?.info('No changes to apply', { planId });
      return { status: 'applied', changedFiles: [], commitSha: undefined };
    }

    // 3. Validate file paths
    for (const file of changedFiles) {
      if (file.includes('../')) {
        const reason = `Path traversal detected in changed file: ${file}`;
        logger?.error('Validation failed', { planId, reason });
        await rollback(handle);
        return { status: 'rejected', changedFiles, rejectionReason: reason };
      }
      if (file.startsWith('/')) {
        const reason = `Absolute path detected in changed file: ${file}`;
        logger?.error('Validation failed', { planId, reason });
        await rollback(handle);
        return { status: 'rejected', changedFiles, rejectionReason: reason };
      }
    }

    // 4. Get full diff for secret scanning
    const diffResult = await exec(handle.path, 'git', ['diff', 'HEAD']);
    const fullDiff = diffResult.stdout;

    // 5. Filter to only added lines (C3: avoid false positives on removed lines)
    const addedLinesOnly = fullDiff
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');

    // 6. Check diff against forbidden patterns
    const patterns = [
      ...DEFAULT_FORBIDDEN_PATTERNS,
      ...(context.forbiddenPatterns ?? []),
    ];

    for (const pattern of patterns) {
      if (pattern.test(addedLinesOnly)) {
        const reason = `Forbidden pattern detected in diff: ${pattern.source}`;
        logger?.error('Secret detected in diff', { planId, pattern: pattern.source });
        await rollback(handle);
        return { status: 'rejected', changedFiles, rejectionReason: reason };
      }
    }

    // 7. Stage all changes
    await exec(handle.path, 'git', ['add', '-A']);

    // 8. Commit
    await exec(handle.path, 'git', ['commit', '-m', context.commitMessage]);

    // 9. Extract SHA
    const shaResult = await exec(handle.path, 'git', ['rev-parse', 'HEAD']);
    const commitSha = shaResult.stdout.trim();

    logger?.info('Artifacts applied', { planId, commitSha, changedFiles });

    return { status: 'applied', commitSha, changedFiles };
  }

  return { apply, rollback };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function dedup(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

async function defaultExecInWorktree(
  worktreePath: string,
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd: worktreePath });
  return { stdout, stderr };
}
