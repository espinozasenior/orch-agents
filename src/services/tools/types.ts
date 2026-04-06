/**
 * P4 — Concurrency-Partitioned Tool Execution: Type definitions
 */

/** A tool_use block from the assistant message. */
export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Registry entry describing a tool's execution contract. */
export interface ToolDefinition {
  name: string;
  /** Return true when the tool can safely run in parallel with others. */
  isConcurrencySafe: (input: Record<string, unknown>) => boolean;
  /** Execute the tool and return a result. */
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

/** Outcome of a single tool execution. */
export interface ToolResult {
  content: string;
  is_error?: boolean;
}

/** A batch of tool calls that share the same concurrency classification. */
export interface Batch {
  isConcurrencySafe: boolean;
  blocks: ToolUseBlock[];
}

/** Update emitted during tool execution. */
export interface ToolExecutionUpdate {
  toolUseId: string;
  result?: ToolResult;
  error?: string;
}
