/**
 * Interactive Task Executor — executes Claude in interactive mode with tool
 * access, scoped to a git worktree directory.
 *
 * Key differences from the standard createClaudeTaskExecutor:
 * - CWD is set to the worktree path (agents see the worktree as their project)
 * - Prompt instructs direct file editing instead of JSON output
 * - Longer default timeout (5 min vs 2 min)
 * - Accepts targetFiles and priorPhaseOutputs for contextual prompts
 */

import { resolve as pathResolve } from 'node:path';
import type { Logger } from '../shared/logger';
import type { TaskExecutionResult } from './task-executor';
import { buildSafeEnv } from './cli-client';

// ---------------------------------------------------------------------------
// Re-export for backward compatibility
// ---------------------------------------------------------------------------

export type { TaskExecutionResult } from './task-executor';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InteractiveExecutionRequest {
  prompt: string;
  agentRole: string;
  agentType: string;
  tier: 1 | 2 | 3;
  phaseType: string;
  timeout: number;
  metadata: Record<string, unknown>;
  /** Absolute path to git worktree — agent CWD */
  worktreePath: string;
  /** Files the agent should focus on */
  targetFiles?: string[];
  /** Prior phase outputs for context */
  priorPhaseOutputs?: string[];
}

export interface InteractiveTaskExecutor {
  execute(request: InteractiveExecutionRequest): Promise<TaskExecutionResult>;
}

export interface InteractiveExecutorDeps {
  /** Path to claude CLI binary. Default: 'claude'. */
  cliBin?: string;
  /** Default timeout per execution in ms. Default: 300_000 (5 min). */
  defaultTimeout?: number;
  /** Optional logger for observability. */
  logger?: Logger;
  /** Allowed tools for the agent. Default: ['Edit','Write','Read','Bash','Grep','Glob']. */
  allowedTools?: string[];
  /** Injectable spawn function for testing. */
  spawnFn?: typeof import('node:child_process').spawn;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an InteractiveTaskExecutor that invokes the Claude CLI to execute
 * prompts with tool access in a worktree directory.
 *
 * Uses `claude --print --dangerously-skip-permissions -` so agents can use
 * tools. The prompt is passed via stdin. CWD is set to the worktree path.
 */
/** Allowed base directories for worktree execution. */
const ALLOWED_WORKTREE_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/'];

export function createInteractiveExecutor(
  deps: InteractiveExecutorDeps = {},
): InteractiveTaskExecutor {
  const {
    cliBin = 'claude',
    defaultTimeout = 300_000,
    logger,
    allowedTools = ['Edit', 'Write', 'Read', 'Bash', 'Grep', 'Glob'],
  } = deps;

  // Lazily resolve spawn so tests can inject a mock
  let resolvedSpawn: typeof import('node:child_process').spawn | undefined = deps.spawnFn;

  return {
    async execute(request: InteractiveExecutionRequest): Promise<TaskExecutionResult> {
      const startTime = Date.now();
      const timeout = request.timeout || defaultTimeout;

      // SECURITY: Validate worktreePath is within an allowed base directory
      // before granting --dangerously-skip-permissions
      const resolved = pathResolve(request.worktreePath);
      const isAllowed = ALLOWED_WORKTREE_PREFIXES.some((prefix) => resolved.startsWith(prefix));
      if (!isAllowed) {
        logger?.error('Interactive executor: worktreePath outside allowed prefixes', {
          worktreePath: resolved,
          allowedPrefixes: ALLOWED_WORKTREE_PREFIXES,
        });
        return {
          status: 'failed',
          output: '',
          duration: Date.now() - startTime,
          error: `worktreePath "${resolved}" is not within allowed directories: ${ALLOWED_WORKTREE_PREFIXES.join(', ')}`,
        };
      }

      try {
        // Lazily import spawn if not injected
        if (!resolvedSpawn) {
          const cp = await import('node:child_process');
          resolvedSpawn = cp.spawn;
        }

        const fullPrompt = buildPrompt(request, allowedTools);

        const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
          const args = ['--print', '--dangerously-skip-permissions', '-'];

          const child = resolvedSpawn!(cliBin, args, {
            cwd: request.worktreePath,
            timeout,
            env: buildSafeEnv(),
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          const pid = child.pid;
          logger?.info('Interactive executor: process spawned', {
            pid,
            cliBin,
            agentRole: request.agentRole,
            phaseType: request.phaseType,
            worktreePath: request.worktreePath,
            timeoutMs: timeout,
          });

          let stdout = '';
          let stderr = '';

          child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
          child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

          child.on('error', reject);
          child.on('close', (code, signal) => {
            const durationMs = Date.now() - startTime;
            if (code !== 0) {
              logger?.warn('Interactive executor: process failed', {
                pid,
                exitCode: code,
                signal,
                stderrPreview: stderr.slice(0, 500),
                durationMs,
              });
              reject(new Error(`claude exited with code ${code}: ${stderr}`));
            } else {
              logger?.info('Interactive executor: process exited', {
                pid,
                exitCode: code,
                stdoutLen: stdout.length,
                stderrLen: stderr.length,
                durationMs,
              });
              resolve({ stdout, stderr, exitCode: code ?? 0 });
            }
          });

          // Write prompt via stdin to avoid ARG_MAX limits
          child.stdin!.write(fullPrompt);
          child.stdin!.end();

          logger?.debug('Interactive executor: prompt delivered', {
            pid,
            agentRole: request.agentRole,
            promptBytes: fullPrompt.length,
          });
        });

        const duration = Date.now() - startTime;

        return {
          status: 'completed',
          output: result.stdout,
          duration,
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const message = err instanceof Error ? err.message : String(err);

        return {
          status: 'failed',
          output: '',
          duration,
          error: message,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the full prompt with worktree context, target files, and prior outputs.
 */
function buildPrompt(
  request: InteractiveExecutionRequest,
  allowedTools: string[],
): string {
  const parts: string[] = [];

  parts.push(`You are working in directory: ${request.worktreePath}`);
  parts.push('You MUST edit files directly. Do NOT return JSON reports.');
  parts.push(`Available tools: ${allowedTools.join(', ')}`);

  if (request.targetFiles && request.targetFiles.length > 0) {
    parts.push(`Focus on these files:\n${request.targetFiles.join('\n')}`);
  }

  if (request.priorPhaseOutputs && request.priorPhaseOutputs.length > 0) {
    parts.push(`Prior analysis:\n${request.priorPhaseOutputs.join('\n---\n')}`);
  }

  parts.push(request.prompt);

  return parts.join('\n\n');
}
