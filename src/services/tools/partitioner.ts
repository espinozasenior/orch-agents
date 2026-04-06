/**
 * P4 — Partition tool-use blocks into concurrency-safe batches.
 *
 * Algorithm (from SPARC spec):
 *  - Walk the ordered list of tool-use blocks.
 *  - Determine isConcurrencySafe for each block via the matching ToolDefinition.
 *  - Consecutive safe blocks are grouped into one concurrent batch.
 *  - Each unsafe block gets its own serial batch.
 *  - Unknown tools (no matching definition) are treated as unsafe.
 *  - If isConcurrencySafe() throws, the tool is treated as unsafe.
 */

import type { Batch, ToolDefinition, ToolUseBlock } from './types.js';

export function partitionToolCalls(
  blocks: ToolUseBlock[],
  tools: Map<string, ToolDefinition>,
): Batch[] {
  const batches: Batch[] = [];

  for (const block of blocks) {
    const isSafe = classifyBlock(block, tools);

    const lastBatch = batches.at(-1);
    if (isSafe && lastBatch?.isConcurrencySafe) {
      lastBatch.blocks.push(block);
    } else {
      batches.push({ isConcurrencySafe: isSafe, blocks: [block] });
    }
  }

  return batches;
}

function classifyBlock(
  block: ToolUseBlock,
  tools: Map<string, ToolDefinition>,
): boolean {
  const tool = tools.get(block.name);
  if (!tool) {
    return false; // Unknown tool → conservative default
  }

  try {
    return tool.isConcurrencySafe(block.input);
  } catch {
    return false; // Error → conservative default
  }
}
