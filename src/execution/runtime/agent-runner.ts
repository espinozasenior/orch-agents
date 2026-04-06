/**
 * Phase 9A: Async Iterator Agent Loop.
 *
 * Replaces poll-based agent communication with an async iterator pattern.
 * Agents block on `for await` and the daemon pushes messages. Integrates
 * P0 auto-compaction, P3 token budget enforcement, max-output recovery,
 * and graceful shutdown via AbortSignal.
 */

import type { Logger } from '../../shared/logger';
import { SAFE_ENV_KEYS } from '../../shared/safe-env';
import type { TransportInbound } from './transport-inbound';
import {
  type AgentMessage,
  type AgentRunnerConfig,
  type AgentRunnerDeps,
  AgentMessageType,
  ContextOverflowError,
  OutputTruncatedError,
  DEFAULT_AGENT_RUNNER_CONFIG,
} from './agent-message-types';

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

export interface AgentRunnerOptions {
  readonly transport: TransportInbound;
  readonly deps: AgentRunnerDeps;
  readonly config?: Partial<AgentRunnerConfig>;
  readonly logger?: Logger;
  readonly abortController?: AbortController;
}

export class AgentRunner {
  private readonly transport: TransportInbound;
  private readonly deps: AgentRunnerDeps;
  private readonly config: AgentRunnerConfig;
  private readonly logger?: Logger;
  private readonly abortController: AbortController;
  private taskCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightPromise: Promise<void> | null = null;
  private shutdownRequested = false;

  constructor(options: AgentRunnerOptions) {
    this.transport = options.transport;
    this.deps = options.deps;
    this.config = { ...DEFAULT_AGENT_RUNNER_CONFIG, ...options.config };
    this.logger = options.logger;
    this.abortController = options.abortController ?? new AbortController();
  }

  /** The stream of messages from the transport, filtered through the runner. */
  async *messageStream(): AsyncGenerator<AgentMessage, void, undefined> {
    for await (const message of this.transport.messages()) {
      if (this.abortController.signal.aborted) break;
      yield message;
    }
  }

  /**
   * Run the agent loop. Blocks until shutdown, abort, or transport end.
   * Returns the number of tasks processed.
   */
  async run(): Promise<number> {
    const signal = this.abortController.signal;
    this.registerShutdownHandlers();

    await this.transport.connect();

    try {
      for await (const message of this.transport.messages()) {
        if (signal.aborted || this.shutdownRequested) break;

        this.resetIdleTimer();

        switch (message.type) {
          case AgentMessageType.KeepAlive:
            // No-op beyond idle timer reset
            continue;

          case AgentMessageType.EnvUpdate:
            this.applyEnvUpdate(message.payload as Record<string, string>);
            continue;

          case AgentMessageType.Shutdown:
            this.logger?.info('Shutdown message received', {
              reason: (message.payload as { reason?: string })?.reason,
            });
            this.shutdownRequested = true;
            break;

          case AgentMessageType.UserTask:
            await this.handleUserTask(message);
            break;

          case AgentMessageType.ControlResponse:
            this.resolveControlPromise(message.id, message.payload);
            continue;

          default:
            this.logger?.warn('Unknown message type', {
              type: (message as AgentMessage).type,
            });
            continue;
        }

        // After user_task or shutdown, check if we should exit
        if (this.shutdownRequested) break;
      }
    } finally {
      await this.drain();
      this.clearIdleTimer();
      await this.transport.disconnect();
    }

    return this.taskCount;
  }

  /** Request graceful shutdown. */
  shutdown(): void {
    this.shutdownRequested = true;
    this.abortController.abort();
  }

  /** Get the current task count. */
  getTaskCount(): number {
    return this.taskCount;
  }

  // -------------------------------------------------------------------------
  // Private: message handlers
  // -------------------------------------------------------------------------

  private async handleUserTask(message: AgentMessage): Promise<void> {
    // FR-9A.06: Per-turn token budget check
    const tokenCount = this.deps.countTokens(message.payload);
    if (tokenCount > this.config.maxTokensPerTurn) {
      const reason = `Exceeds per-turn budget: ${tokenCount} > ${this.config.maxTokensPerTurn}`;
      this.logger?.warn('Turn budget exceeded', { reason, messageId: message.id });
      this.deps.sendResponse(message.id, { error: reason });
      return;
    }

    // Execute with retry (FR-9A.08 max-output recovery + FR-9A.05 reactive compact)
    const response = await this.executeWithRetry(message);
    this.deps.sendResponse(message.id, response);

    // FR-9A.07: Task budget enforcement
    this.taskCount++;
    if (this.taskCount >= this.config.maxTasks) {
      this.logger?.info('Task budget exhausted', {
        taskCount: this.taskCount,
        maxTasks: this.config.maxTasks,
      });
      this.shutdownRequested = true;
      return;
    }

    // FR-9A.04: Auto-compact at 80% threshold
    const currentTokens = this.deps.getCurrentTokenCount();
    const threshold = this.config.contextWindow * this.config.autoCompactThreshold;
    if (currentTokens > threshold) {
      this.logger?.info('Auto-compact triggered', {
        currentTokens,
        threshold,
      });
      const targetTokens = this.config.contextWindow * 0.6;
      const history = this.deps.getConversationHistory();
      const compacted = await this.deps.compactHistory(history, targetTokens);
      this.deps.setConversationHistory(compacted);
    }
  }

  private async executeWithRetry(message: AgentMessage): Promise<unknown> {
    const partials: unknown[] = [];

    for (let attempt = 0; attempt <= this.config.maxOutputRetries; attempt++) {
      try {
        this.inFlightPromise = Promise.resolve(); // track in-flight
        const result = await this.deps.executeTask(message.payload);
        this.inFlightPromise = null;
        return result;
      } catch (err) {
        this.inFlightPromise = null;

        // FR-9A.05: Reactive compact on context overflow
        if (err instanceof ContextOverflowError) {
          this.logger?.warn('Context overflow, triggering reactive compact', {
            attempt,
          });
          const targetTokens =
            this.config.contextWindow * this.config.reactiveCompactTarget;
          const history = this.deps.getConversationHistory();
          const compacted = await this.deps.compactHistory(history, targetTokens);
          this.deps.setConversationHistory(compacted);
          continue;
        }

        // FR-9A.08: Max-output recovery
        if (err instanceof OutputTruncatedError) {
          partials.push(err.partialResponse);
          if (attempt < this.config.maxOutputRetries) {
            this.logger?.info('Output truncated, retrying with continuation', {
              attempt: attempt + 1,
              maxRetries: this.config.maxOutputRetries,
            });
            continue;
          }
          // Return concatenated partials after exhausting retries
          return { partials, truncated: true };
        }

        // Unknown error, re-throw
        throw err;
      }
    }

    // Should not reach here, but handle gracefully
    return { partials, truncated: true };
  }

  // -------------------------------------------------------------------------
  // Private: lifecycle helpers
  // -------------------------------------------------------------------------

  private readonly controlPromises = new Map<
    string,
    (value: unknown) => void
  >();

  private resolveControlPromise(id: string, payload: unknown): void {
    const resolve = this.controlPromises.get(id);
    if (resolve) {
      this.controlPromises.delete(id);
      resolve(payload);
    }
  }

  private applyEnvUpdate(env: Record<string, string>): void {
    const rejected: string[] = [];
    for (const [key, value] of Object.entries(env)) {
      if (SAFE_ENV_KEYS.has(key) || key.startsWith('ORCH_')) {
        process.env[key] = value;
      } else {
        rejected.push(key);
      }
    }
    if (rejected.length > 0) {
      this.logger?.warn('Rejected unsafe env update keys', { rejected });
    }
    this.logger?.debug('Environment updated', { keys: Object.keys(env).filter(k => !rejected.includes(k)) });
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.logger?.warn('Idle timeout reached, shutting down');
      this.shutdown();
    }, this.config.keepAliveIntervalMs * 2);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private registerShutdownHandlers(): void {
    const handler = () => {
      this.logger?.info('Shutdown signal received');
      this.shutdown();
    };
    process.once('SIGTERM', handler);
    process.once('SIGINT', handler);
  }

  private async drain(): Promise<void> {
    if (!this.inFlightPromise) return;

    this.logger?.info('Draining in-flight work', {
      timeoutMs: this.config.drainTimeoutMs,
    });

    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, this.config.drainTimeoutMs),
    );

    await Promise.race([this.inFlightPromise, timeout]);
  }
}
