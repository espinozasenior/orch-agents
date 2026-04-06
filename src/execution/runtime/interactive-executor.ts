/**
 * Interactive Task Executor — interface types for Claude Code SDK execution.
 *
 * The InteractiveTaskExecutor interface is the common contract used by:
 * - SDK executor (createSdkExecutor)
 * - Harness session (P0 compaction + P3 budget)
 * - Enhanced executor (harness + coordinator layers)
 * - Simple executor (agent orchestration)
 *
 * The legacy CLI-spawn implementation has been removed.
 * All execution flows through the Claude Code SDK.
 */

import type { TaskExecutionResult } from './task-executor';

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
  /**
   * Fork context: inherited parent conversation messages serialized as a
   * prompt prefix. When set, the executor prepends this context before the
   * agent prompt so the forked child shares the parent's conversation
   * history (with tool_result content replaced by a constant placeholder
   * for prompt cache sharing).
   */
  forkContextPrefix?: string;
}

export interface InteractiveTaskExecutor {
  execute(request: InteractiveExecutionRequest): Promise<TaskExecutionResult>;
}
