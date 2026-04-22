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
import type { AgentSpawnMode } from '../../shared/config';
import type { SwarmDaemon } from './swarm-daemon';
import type { WorktreeManager } from '../workspace/worktree-manager';
import type { EventBus } from '../../kernel/event-bus';
import type { DeferredToolRegistry } from '../../services/deferred-tools/registry.js';
import { createDirectSpawnStrategy } from './direct-spawn-strategy';
import { createDirectSpawnToolDef } from './direct-spawn-tool';

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
  /** Agent spawn mode: 'sdk' (default) or 'direct' (SwarmDaemon dispatch). */
  agentSpawnMode?: AgentSpawnMode;
  /** SwarmDaemon instance for direct spawn mode child dispatch. */
  swarmDaemon?: SwarmDaemon;
  /** WorktreeManager for creating isolated child worktrees. */
  worktreeManager?: WorktreeManager;
  /** EventBus for domain event emission. */
  eventBus?: EventBus;
  /** DeferredToolRegistry to override Agent tool in direct mode. */
  deferredToolRegistry?: DeferredToolRegistry;
  /** Parent plan ID for domain event correlation. */
  parentPlanId?: string;
  /** Parent AbortSignal for cancellation propagation. */
  parentAbortSignal?: AbortSignal;
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
  // Direct spawn mode: replace the NOOP Agent tool with real dispatch
  if (
    deps.agentSpawnMode === 'direct' &&
    deps.swarmDaemon &&
    deps.worktreeManager &&
    deps.deferredToolRegistry
  ) {
    const strategy = createDirectSpawnStrategy({
      swarmDaemon: deps.swarmDaemon,
      worktreeManager: deps.worktreeManager,
      logger: deps.logger ?? { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as unknown as Logger,
      parentAbortSignal: deps.parentAbortSignal,
      eventBus: deps.eventBus,
      parentPlanId: deps.parentPlanId,
    });

    deps.deferredToolRegistry.override(createDirectSpawnToolDef(strategy));
  }

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
