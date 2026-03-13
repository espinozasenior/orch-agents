/**
 * Task Executor — executes prompts and returns structured results.
 *
 * Two implementations:
 * - createStubTaskExecutor() — canned results for tests and stub mode
 * - createClaudeTaskExecutor() — real Claude CLI invocation (Phase 4+)
 */

import type { SPARCPhase } from '../types';
import type { Logger } from '../shared/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TaskExecutionRequest {
  prompt: string;
  agentRole: string;
  agentType: string;
  tier: 1 | 2 | 3;
  phaseType: SPARCPhase;
  timeout: number;
  metadata: Record<string, unknown>;
}

export interface TaskExecutionResult {
  status: 'completed' | 'failed';
  output: string;
  duration: number;
  error?: string;
}

export interface TaskExecutor {
  execute(request: TaskExecutionRequest): Promise<TaskExecutionResult>;
}

// ---------------------------------------------------------------------------
// Stub implementation (for tests and default mode)
// ---------------------------------------------------------------------------

export interface StubTaskExecutorOpts {
  /** Fraction of requests that fail (0–1). Default: 0. */
  failRate?: number;
}

/**
 * Create a stub TaskExecutor that returns canned structured results.
 * Useful for testing the full pipeline without real Claude calls.
 */
export function createStubTaskExecutor(opts: StubTaskExecutorOpts = {}): TaskExecutor {
  const { failRate = 0 } = opts;

  return {
    async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
      const startTime = Date.now();

      if (Math.random() < failRate) {
        return {
          status: 'failed',
          output: '',
          duration: Date.now() - startTime,
          error: `Stub failure for ${request.agentRole} in ${request.phaseType}`,
        };
      }

      const output = JSON.stringify({
        phaseType: request.phaseType,
        agentRole: request.agentRole,
        summary: `Stub ${request.phaseType} analysis completed by ${request.agentRole}`,
        artifacts: [
          {
            type: 'analysis',
            content: `Stub output for ${request.phaseType} phase`,
          },
        ],
        issues: [],
        status: 'completed',
      });

      return {
        status: 'completed',
        output,
        duration: Date.now() - startTime,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Real Claude implementation (Phase 4+)
// ---------------------------------------------------------------------------

export interface ClaudeTaskExecutorOpts {
  /** Path to claude CLI binary. Default: 'claude'. */
  cliBin?: string;
  /** Default timeout per execution in ms. Default: 120000. */
  defaultTimeout?: number;
  /** Optional logger for observability. */
  logger?: Logger;
}

/**
 * Create a TaskExecutor that invokes the Claude CLI to execute prompts.
 *
 * Uses `claude --print -` for non-interactive single-prompt execution.
 * The prompt is passed via stdin to avoid ARG_MAX limits and shell escaping issues.
 */
export function createClaudeTaskExecutor(opts: ClaudeTaskExecutorOpts = {}): TaskExecutor {
  const { cliBin = 'claude', defaultTimeout = 120_000, logger } = opts;

  return {
    async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
      const startTime = Date.now();
      const timeout = request.timeout || defaultTimeout;

      try {
        const { spawn } = await import('node:child_process');

        const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
          const child = spawn(cliBin, ['--print', '-'], {
            timeout,
            env: { ...process.env, FORCE_COLOR: '0' },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          const pid = child.pid;
          logger?.info('Task executor: process spawned', {
            pid,
            cliBin,
            agentRole: request.agentRole,
            phaseType: request.phaseType,
            timeoutMs: timeout,
          });

          let stdout = '';
          let stderr = '';

          child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

          child.on('error', reject);
          child.on('close', (code, signal) => {
            const durationMs = Date.now() - startTime;
            if (code !== 0) {
              logger?.warn('Task executor: process failed', {
                pid,
                exitCode: code,
                signal,
                stderrPreview: stderr.slice(0, 500),
                durationMs,
              });
              reject(new Error(`claude exited with code ${code}: ${stderr}`));
            } else {
              logger?.info('Task executor: process exited', {
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
          child.stdin.write(request.prompt);
          child.stdin.end();

          logger?.debug('Task executor: prompt delivered', {
            pid,
            agentRole: request.agentRole,
            promptBytes: request.prompt.length,
          });
        });

        const duration = Date.now() - startTime;

        // Try to extract JSON from the response
        const jsonOutput = extractJson(result.stdout);

        logger?.debug('Task executor: output parsed', {
          agentRole: request.agentRole,
          jsonExtracted: jsonOutput !== undefined,
        });

        return {
          status: 'completed',
          output: jsonOutput ?? result.stdout,
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
 * Extract a JSON block from Claude's response text.
 * Looks for ```json ... ``` blocks or raw JSON objects.
 */
function extractJson(text: string): string | undefined {
  // Try fenced code block first
  const fenced = text.match(/```json\s*\n?([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      JSON.parse(fenced[1].trim());
      return fenced[1].trim();
    } catch { /* not valid JSON */ }
  }

  // Try raw JSON object (non-greedy: find the first balanced { ... })
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (jsonMatch?.[0]) {
    try {
      JSON.parse(jsonMatch[0]);
      return jsonMatch[0];
    } catch { /* not valid JSON, try greedy fallback */ }
  }

  // Greedy fallback for nested JSON objects
  const greedyMatch = text.match(/\{[\s\S]*\}/);
  if (greedyMatch?.[0] && greedyMatch[0] !== jsonMatch?.[0]) {
    try {
      JSON.parse(greedyMatch[0]);
      return greedyMatch[0];
    } catch { /* not valid JSON */ }
  }

  return undefined;
}
