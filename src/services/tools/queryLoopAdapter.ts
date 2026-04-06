/**
 * P4 — Query Loop Adapter
 *
 * Bridges the query loop's executeTool callback signature with P4's
 * runTools orchestrator. Converts query loop tool blocks to P4
 * ToolUseBlock format, runs them through the partitioner/executor,
 * and converts results back to QueryMessage format.
 */

import { runTools } from './executor.js';
import type { ToolDefinition, ToolUseBlock } from './types.js';

// ---------------------------------------------------------------------------
// Types matching query loop contract
// ---------------------------------------------------------------------------

/** Shape of tool blocks as received from the query loop. */
interface QueryToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Shape of messages returned to the query loop. */
interface QueryMessage {
  uuid: string;
  type: 'user' | 'assistant' | 'system';
  content: string;
}

/** Result returned to the query loop's executeTool callback. */
interface ToolExecutionResult {
  messages: QueryMessage[];
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Creates an executeTool callback compatible with QueryParams.executeTool.
 *
 * This bridges the query loop's tool execution interface with P4's
 * concurrency-partitioned runTools orchestrator.
 *
 * @param registry - P4 tool registry (Map<name, ToolDefinition>)
 * @param maxConcurrency - Optional concurrency limit for read-only batches
 * @returns Callback matching QueryParams.executeTool signature
 */
export function createToolExecutionCallback(
  registry: Map<string, ToolDefinition>,
  maxConcurrency?: number,
): (toolUseBlocks: QueryToolUseBlock[]) => Promise<ToolExecutionResult> {
  return async (toolUseBlocks: QueryToolUseBlock[]): Promise<ToolExecutionResult> => {
    if (toolUseBlocks.length === 0) {
      return { messages: [] };
    }

    // Convert query loop blocks to P4 ToolUseBlock format
    const blocks: ToolUseBlock[] = toolUseBlocks.map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }));

    // Run through P4 partitioner + executor
    const updates = await runTools(blocks, registry, maxConcurrency);

    // Convert ToolExecutionUpdate[] to QueryMessage[]
    const messages: QueryMessage[] = updates.map((update) => ({
      uuid: update.toolUseId,
      type: 'system' as const,
      content: update.result?.content ?? update.error ?? '',
    }));

    return { messages };
  };
}
