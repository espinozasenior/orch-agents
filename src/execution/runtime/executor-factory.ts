/**
 * Executor Factory
 *
 * Builds a fully-configured InteractiveTaskExecutor with all harness
 * enhancements applied. This is the entry point that index.ts uses
 * to create the executor.
 */

import type { InteractiveTaskExecutor } from './interactive-executor';
import { createEnhancedExecutor, type EnhancedExecutorDeps } from './enhanced-executor';
import type { Logger } from '../../shared/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecutorFactoryDeps {
  /** The raw base executor (interactive CLI or SDK) */
  baseExecutor: InteractiveTaskExecutor;
  /** Logger for observability */
  logger?: Logger;
  /** Context window size in tokens. Default: 200_000 */
  contextWindowTokens?: number;
  /** Token budget per session. Default: undefined (no budget) */
  tokenBudget?: number;
  /** Enable compaction. Default: true */
  enableCompaction?: boolean;
  /** MCP clients available to workers */
  mcpClients?: Array<{ name: string }>;
  /** Scratchpad directory for worker file exchange */
  scratchpadDir?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a fully-enhanced executor from a base executor.
 *
 * Applies the following enhancement layers:
 * 1. Harness session (P0 compaction + P3 budget tracking)
 * 2. Coordinator session (P2 coordinator prompt, when mode active)
 *
 * Usage in index.ts:
 * ```ts
 * import { buildExecutor } from './execution/runtime/executor-factory';
 * const executor = buildExecutor({ baseExecutor: interactiveExecutor, logger });
 * ```
 */
export function buildExecutor(deps: ExecutorFactoryDeps): InteractiveTaskExecutor {
  const enhancedDeps: EnhancedExecutorDeps = {
    baseExecutor: deps.baseExecutor,
    logger: deps.logger,
    contextWindowTokens: deps.contextWindowTokens,
    tokenBudget: deps.tokenBudget,
    enableCompaction: deps.enableCompaction,
    mcpClients: deps.mcpClients,
    scratchpadDir: deps.scratchpadDir,
  };

  return createEnhancedExecutor(enhancedDeps);
}
