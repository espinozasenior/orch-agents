/**
 * P4 — Tool execution with concurrency control.
 *
 * - runToolsConcurrently: executes a batch with a semaphore-based concurrency limit.
 * - runToolsSerially: executes tools one at a time in order.
 * - runTools: orchestrator that partitions then dispatches.
 */

import { partitionToolCalls } from './partitioner.js';
import { DEFAULT_MAX_CONCURRENCY } from './concurrencyClassifier.js';
import type {
  ToolDefinition,
  ToolExecutionUpdate,
  ToolResult,
  ToolUseBlock,
} from './types.js';
import type { Batch } from './types.js';

// ---------------------------------------------------------------------------
// Semaphore – simple concurrency limiter (no external deps)
// ---------------------------------------------------------------------------

class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// Concurrent execution
// ---------------------------------------------------------------------------

export async function runToolsConcurrently(
  batch: Batch,
  tools: Map<string, ToolDefinition>,
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
): Promise<ToolExecutionUpdate[]> {
  const sem = new Semaphore(maxConcurrency);

  const promises = batch.blocks.map(async (block) => {
    await sem.acquire();
    try {
      return await executeBlock(block, tools);
    } finally {
      sem.release();
    }
  });

  return Promise.all(promises);
}

// ---------------------------------------------------------------------------
// Serial execution
// ---------------------------------------------------------------------------

export async function runToolsSerially(
  batch: Batch,
  tools: Map<string, ToolDefinition>,
): Promise<ToolExecutionUpdate[]> {
  const results: ToolExecutionUpdate[] = [];
  for (const block of batch.blocks) {
    results.push(await executeBlock(block, tools));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runTools(
  blocks: ToolUseBlock[],
  tools: Map<string, ToolDefinition>,
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
): Promise<ToolExecutionUpdate[]> {
  const batches = partitionToolCalls(blocks, tools);
  const allUpdates: ToolExecutionUpdate[] = [];

  for (const batch of batches) {
    const updates = batch.isConcurrencySafe
      ? await runToolsConcurrently(batch, tools, maxConcurrency)
      : await runToolsSerially(batch, tools);
    allUpdates.push(...updates);
  }

  return allUpdates;
}

// ---------------------------------------------------------------------------
// Single block execution
// ---------------------------------------------------------------------------

async function executeBlock(
  block: ToolUseBlock,
  tools: Map<string, ToolDefinition>,
): Promise<ToolExecutionUpdate> {
  const tool = tools.get(block.name);
  if (!tool) {
    return {
      toolUseId: block.id,
      error: `Unknown tool: ${block.name}`,
      result: { content: `Unknown tool: ${block.name}`, is_error: true },
    };
  }

  try {
    const result: ToolResult = await tool.execute(block.input);
    return { toolUseId: block.id, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      toolUseId: block.id,
      error: message,
      result: { content: message, is_error: true },
    };
  }
}
