/**
 * Enhanced Executor — Composition Point
 *
 * Composes all executor enhancements in the correct order:
 *   base → harness (compaction + budget) → coordinator (if enabled)
 *
 * This is the single entry point for building a fully-enhanced executor.
 */

import type { InteractiveTaskExecutor } from './interactive-executor';
import { createHarnessSession, type HarnessSessionDeps } from './harness-session';
import { createCoordinatorSession } from './coordinator-session';
import type { Logger } from '../../shared/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EnhancedExecutorDeps {
  baseExecutor: InteractiveTaskExecutor;
  logger?: Logger;
  contextWindowTokens?: number;
  tokenBudget?: number;
  enableCompaction?: boolean;
  mcpClients?: Array<{ name: string }>;
  scratchpadDir?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the full enhanced executor stack:
 *   base → harness (compaction + budget) → coordinator (if enabled)
 *
 * Each layer wraps the previous one via the decorator pattern.
 */
export function createEnhancedExecutor(
  deps: EnhancedExecutorDeps,
): InteractiveTaskExecutor {
  const {
    baseExecutor,
    logger,
    contextWindowTokens,
    tokenBudget,
    enableCompaction,
    mcpClients,
    scratchpadDir,
  } = deps;

  // Layer 1: Harness (compaction + budget tracking)
  const harnessDeps: HarnessSessionDeps = {
    baseExecutor,
    logger,
    contextWindowTokens,
    tokenBudget,
    enableCompaction,
  };
  const harnessExecutor = createHarnessSession(harnessDeps);

  // Layer 2: Coordinator (prompt enhancement when coordinator mode active)
  const coordinatorExecutor = createCoordinatorSession({
    baseExecutor: harnessExecutor,
    logger,
    mcpClients,
    scratchpadDir,
  });

  return coordinatorExecutor;
}
