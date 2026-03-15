/**
 * Task Executor — executes prompts and returns structured results.
 *
 * Two implementations:
 * - createStubTaskExecutor() — canned results for tests and stub mode
 * - createClaudeTaskExecutor() — real Claude CLI invocation (Phase 4+)
 */

import { spawn as _spawn } from 'node:child_process';
import type { SPARCPhase } from '../types';
import type { Logger } from '../shared/logger';
import { createAgentSandbox, type AgentSandbox } from './agent-sandbox';
import { buildSafeEnv } from './cli-client';

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
  status: 'completed' | 'failed' | 'cancelled';
  output: string;
  duration: number;
  error?: string;
  tokenUsage?: { input: number; output: number };
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
      let sandbox: AgentSandbox | undefined;

      try {
        // Create an isolated sandbox to prevent hook pollution
        sandbox = createAgentSandbox();

          const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
          const child = _spawn(cliBin, ['--print', '-'], {
            cwd: sandbox!.cwd,
            timeout,
            // QUALITY-10 FIX: Only pass safe env vars, not entire process.env
            env: buildSafeEnv(),
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          const pid = child.pid;
          logger?.info('Task executor: process spawned', {
            pid,
            cliBin,
            agentRole: request.agentRole,
            phaseType: request.phaseType,
            timeoutMs: timeout,
            sandboxCwd: sandbox!.cwd,
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
      } finally {
        // Always clean up sandbox, even on failure
        sandbox?.cleanup();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a line is hook output that should be stripped before JSON extraction.
 * Only matches standalone hook diagnostic lines, not JSON content.
 */
function isHookOutput(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;

  // [hook: session-start], [hook: session-end], etc.
  if (trimmed.startsWith('[hook:')) return true;

  // [SessionEnd hook], [UserPromptSubmit hook], etc.
  if (/^\[.*hook.*\]/i.test(trimmed)) return true;

  // Known hook diagnostic messages
  if (trimmed.startsWith('Session restored')) return true;
  if (trimmed.startsWith('Memory imported')) return true;
  if (trimmed.startsWith('Intelligence consolidated')) return true;
  if (trimmed.startsWith('Auto-memory synced')) return true;

  return false;
}

/**
 * Strip known hook output lines from text before JSON extraction.
 * Only strips lines that are clearly hook diagnostic output.
 * Preserves any line that could be part of valid JSON.
 */
function stripHookOutput(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isHookOutput(line))
    .join('\n');
}

/**
 * Extract the first balanced JSON object from text using brace counting.
 * Handles nested objects correctly unlike regex approaches.
 */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

/**
 * Extract a JSON block from Claude's response text.
 * First strips known hook output patterns, then looks for
 * ```json ... ``` blocks or raw JSON objects.
 */
export function extractJson(text: string): string | undefined {
  // Step 1: Strip known hook output patterns (defense-in-depth)
  const cleaned = stripHookOutput(text);

  // Try fenced code block first
  const fenced = cleaned.match(/```json\s*\n?([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      JSON.parse(fenced[1].trim());
      return fenced[1].trim();
    } catch { /* not valid JSON */ }
  }

  // DESIGN-04 FIX: Use balanced brace matching instead of fragile regex
  const jsonStr = extractBalancedJson(cleaned);
  if (jsonStr) {
    try {
      JSON.parse(jsonStr);
      return jsonStr;
    } catch { /* not valid JSON */ }
  }

  return undefined;
}
