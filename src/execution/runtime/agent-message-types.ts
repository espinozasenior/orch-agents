/**
 * Phase 9A: Agent message types and configuration interfaces.
 *
 * Defines the discriminated union for all agent-facing messages,
 * the runner configuration, and the dependency injection interface.
 */

// ---------------------------------------------------------------------------
// Message type enum
// ---------------------------------------------------------------------------

export const AgentMessageType = {
  UserTask: 'user_task',
  ControlResponse: 'control_response',
  KeepAlive: 'keep_alive',
  EnvUpdate: 'env_update',
  Shutdown: 'shutdown',
} as const;

export type AgentMessageTypeLiteral =
  (typeof AgentMessageType)[keyof typeof AgentMessageType];

// ---------------------------------------------------------------------------
// Discriminated union: AgentMessage
// ---------------------------------------------------------------------------

export interface AgentMessageBase {
  readonly id: string;
  readonly timestamp: number;
}

export interface UserTaskMessage extends AgentMessageBase {
  readonly type: typeof AgentMessageType.UserTask;
  readonly payload: unknown;
}

export interface ControlResponseMessage extends AgentMessageBase {
  readonly type: typeof AgentMessageType.ControlResponse;
  readonly payload: unknown;
}

export interface KeepAliveMessage extends AgentMessageBase {
  readonly type: typeof AgentMessageType.KeepAlive;
  readonly payload?: undefined;
}

export interface EnvUpdateMessage extends AgentMessageBase {
  readonly type: typeof AgentMessageType.EnvUpdate;
  readonly payload: Record<string, string>;
}

export interface ShutdownMessage extends AgentMessageBase {
  readonly type: typeof AgentMessageType.Shutdown;
  readonly payload?: { reason?: string };
}

export type AgentMessage =
  | UserTaskMessage
  | ControlResponseMessage
  | KeepAliveMessage
  | EnvUpdateMessage
  | ShutdownMessage;

// ---------------------------------------------------------------------------
// Runner configuration
// ---------------------------------------------------------------------------

export interface AgentRunnerConfig {
  /** Model context window size in tokens (default 200_000). */
  readonly contextWindow: number;
  /** Auto-compact threshold as fraction of contextWindow (default 0.80). */
  readonly autoCompactThreshold: number;
  /** Reactive compact target as fraction of contextWindow (default 0.50). */
  readonly reactiveCompactTarget: number;
  /** Max tokens per turn (default Infinity = no limit). */
  readonly maxTokensPerTurn: number;
  /** Max tool calls per conversation before shutdown (default 200). */
  readonly maxTasks: number;
  /** Max retries on truncated output (default 3). */
  readonly maxOutputRetries: number;
  /** Keep-alive interval in ms (default 120_000). */
  readonly keepAliveIntervalMs: number;
  /** Drain timeout on shutdown in ms (default 30_000). */
  readonly drainTimeoutMs: number;
}

export const DEFAULT_AGENT_RUNNER_CONFIG: AgentRunnerConfig = {
  contextWindow: 200_000,
  autoCompactThreshold: 0.80,
  reactiveCompactTarget: 0.50,
  maxTokensPerTurn: Infinity,
  maxTasks: 200,
  maxOutputRetries: 3,
  keepAliveIntervalMs: 120_000,
  drainTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface AgentRunnerDeps {
  /** Count tokens in a payload. */
  countTokens(payload: unknown): number;
  /** Execute a task and return the result. */
  executeTask(payload: unknown): Promise<unknown>;
  /** Send a response back to the daemon. */
  sendResponse(messageId: string, response: unknown): void;
  /** Summarize older conversation turns. */
  compactHistory(
    history: unknown[],
    targetTokens: number,
  ): Promise<unknown[]>;
  /** Get current accumulated token count. */
  getCurrentTokenCount(): number;
  /** Get the mutable conversation history. */
  getConversationHistory(): unknown[];
  /** Replace conversation history after compaction. */
  setConversationHistory(history: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Error types for retry logic
// ---------------------------------------------------------------------------

export class ContextOverflowError extends Error {
  constructor(message = 'Context length exceeded') {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

export class OutputTruncatedError extends Error {
  readonly partialResponse: unknown;
  constructor(partialResponse: unknown) {
    super('Output truncated due to max_output_tokens');
    this.name = 'OutputTruncatedError';
    this.partialResponse = partialResponse;
  }
}
