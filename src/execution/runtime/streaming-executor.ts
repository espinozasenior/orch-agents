/**
 * Streaming Task Executor — executes prompts with real-time chunk streaming.
 *
 * Implements the TaskExecutor interface while emitting AgentChunk events via
 * EventBus as bytes arrive. This is a parallel concern — callers see no
 * interface change; streaming is observed through event subscriptions.
 *
 * Integrates AgentTracker for per-agent status and CancellationController
 * for graceful SIGTERM/SIGKILL cancellation.
 */

import { spawn as _spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { TaskExecutionRequest, TaskExecutionResult, TaskExecutor } from './task-executor';
import type { EventBus } from '../../shared/event-bus';
import { createDomainEvent } from '../../shared/event-bus';
import type { AgentTracker } from './agent-tracker';
import type { CancellationController } from './cancellation-controller';
import { parseChunk, tryParseTokens } from './output-parser';
import type { Logger } from '../../shared/logger';
import { createAgentSandbox, type AgentSandbox } from './agent-sandbox';
import { buildSafeEnv } from '../../shared/safe-env';
import { extractJson } from './task-executor';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StreamingTaskExecutorOpts {
  eventBus: EventBus;
  agentTracker: AgentTracker;
  cancellationController: CancellationController;
  /** Path to claude CLI binary. Default: 'claude'. */
  cliBin?: string;
  /** CLI arguments. Default: ['--print', '-']. */
  cliArgs?: string[];
  /** Default timeout per execution in ms. Default: 120000. */
  defaultTimeout?: number;
  /** Optional logger. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a StreamingTaskExecutor that invokes the Claude CLI with real-time
 * chunk streaming via EventBus, per-agent tracking, and graceful cancellation.
 */
export function createStreamingTaskExecutor(opts: StreamingTaskExecutorOpts): TaskExecutor {
  const {
    eventBus,
    agentTracker,
    cancellationController,
    cliBin = 'claude',
    cliArgs = ['--print', '-'],
    defaultTimeout = 120_000,
    logger,
  } = opts;

  return {
    async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
      const startTime = Date.now();
      const timeout = request.timeout || defaultTimeout;
      const execId = randomUUID();
      const planId = (request.metadata?.planId as string) ?? 'unknown';
      let sandbox: AgentSandbox | undefined;

      // Spawn in agent tracker
      agentTracker.spawn(execId, planId, request.agentRole, request.agentType, request.phaseType);

      // Publish AgentSpawned event
      eventBus.publish(createDomainEvent('AgentSpawned', {
        execId,
        planId,
        agentRole: request.agentRole,
        agentType: request.agentType,
        phaseType: request.phaseType,
      }));

      try {
        sandbox = createAgentSandbox();

        const result = await new Promise<{ stdout: string; stderr: string; exitCode: number; cancelled: boolean }>((resolve, reject) => {
          const child = _spawn(cliBin, cliArgs, {
            cwd: sandbox!.cwd,
            timeout,
            env: buildSafeEnv(),
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          // Register for cancellation
          cancellationController.register(execId, child, planId);

          logger?.info('Streaming executor: process spawned', {
            pid: child.pid,
            execId,
            agentRole: request.agentRole,
            phaseType: request.phaseType,
          });

          let stdout = '';
          let stderr = '';
          let wasCancelled = false;

          child.stdout.on('data', (chunk: Buffer) => {
            const chunkStr = chunk.toString();
            const prevBuffer = stdout;
            stdout += chunkStr;

            // Update tracker
            agentTracker.touch(execId, chunk.length);

            // Parse chunk for signals (pass buffer state before this chunk)
            const signals = parseChunk(chunkStr, prevBuffer);
            if (signals.toolUse) {
              agentTracker.recordSignal(execId, 'toolUse');
              logger?.debug('Streaming executor: tool_use detected', { execId });
            }
            if (signals.thinking) {
              agentTracker.recordSignal(execId, 'thinking');
            }
            if (signals.jsonComplete) {
              agentTracker.recordSignal(execId, 'json');
            }

            // Publish chunk event
            eventBus.publish(createDomainEvent('AgentChunk', {
              execId,
              planId,
              agentRole: request.agentRole,
              chunk: chunkStr,
              timestamp: new Date().toISOString(),
            }));
          });

          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          child.on('error', (err) => {
            cancellationController.unregister(execId);
            reject(err);
          });

          child.on('close', (code, signal) => {
            cancellationController.unregister(execId);

            // Detect cancellation: SIGTERM or SIGKILL signal
            if (signal === 'SIGTERM' || signal === 'SIGKILL') {
              wasCancelled = true;
            }

            const durationMs = Date.now() - startTime;

            if (wasCancelled) {
              resolve({ stdout, stderr, exitCode: code ?? 1, cancelled: true });
            } else if (code !== 0) {
              logger?.warn('Streaming executor: process failed', {
                execId,
                exitCode: code,
                signal,
                durationMs,
              });
              reject(new Error(`claude exited with code ${code}: ${stderr}`));
            } else {
              logger?.info('Streaming executor: process exited', {
                execId,
                exitCode: code,
                stdoutLen: stdout.length,
                durationMs,
              });
              resolve({ stdout, stderr, exitCode: code ?? 0, cancelled: false });
            }
          });

          // Write prompt via stdin
          child.stdin.write(request.prompt);
          child.stdin.end();
        });

        const duration = Date.now() - startTime;

        // Handle cancellation
        if (result.cancelled) {
          agentTracker.cancel(execId);
          eventBus.publish(createDomainEvent('AgentCancelled', {
            execId,
            planId,
            agentRole: request.agentRole,
            duration,
          }));
          return {
            status: 'cancelled',
            output: result.stdout,
            duration,
          };
        }

        // Extract token usage from stderr
        const tokenUsage = tryParseTokens(result.stderr);

        // Extract JSON from output
        const jsonOutput = extractJson(result.stdout);

        // Mark completed in tracker
        agentTracker.complete(execId, tokenUsage);

        // Publish AgentCompleted event
        eventBus.publish(createDomainEvent('AgentCompleted', {
          execId,
          planId,
          agentRole: request.agentRole,
          duration,
          tokenUsage,
        }));

        return {
          status: 'completed',
          output: jsonOutput ?? result.stdout,
          duration,
          tokenUsage,
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const message = err instanceof Error ? err.message : String(err);

        // Mark failed in tracker
        agentTracker.fail(execId);

        // Publish AgentFailed event
        eventBus.publish(createDomainEvent('AgentFailed', {
          execId,
          planId,
          agentRole: request.agentRole,
          error: message,
          duration,
        }));

        return {
          status: 'failed',
          output: '',
          duration,
          error: message,
        };
      } finally {
        sandbox?.cleanup();
      }
    },
  };
}
