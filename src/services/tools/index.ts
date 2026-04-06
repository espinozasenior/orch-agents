/**
 * P4 — Concurrency-Partitioned Tool Execution: public API.
 */

export type {
  ToolUseBlock,
  ToolDefinition,
  ToolResult,
  Batch,
  ToolExecutionUpdate,
} from './types.js';

export { partitionToolCalls } from './partitioner.js';

export {
  runTools,
  runToolsConcurrently,
  runToolsSerially,
} from './executor.js';

export {
  getDefaultConcurrencyClassifier,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  DEFAULT_MAX_CONCURRENCY,
} from './concurrencyClassifier.js';

export type { ToolExecutionDelegate } from './toolDefinitions.js';

export {
  createToolRegistry,
  createDefaultToolRegistry,
  registerTool,
} from './toolDefinitions.js';

export { createToolExecutionCallback } from './queryLoopAdapter.js';
