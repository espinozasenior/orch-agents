/**
 * Compaction Pipeline Orchestrator
 *
 * Chains Tier 1 (Tool Result Budget) -> Tier 2 (Snip) -> Tier 3 (Auto Compact)
 * into a single pipeline pass. Tier 4 (Reactive) is called separately on
 * prompt_too_long errors.
 */

export {
  type CompactMessage,
  type CompactContentBlock,
  type CompactionConfig,
  type CompactionResult,
  type CompactionPipelineResult,
  type AutoCompactTrackingState,
  type ContentReplacementRecord,
  type SnipCompactResult,
  type TokenWarningState,
  createDefaultConfig,
  createTrackingState,
  AUTOCOMPACT_BUFFER_TOKENS,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  WARNING_THRESHOLD_BUFFER_TOKENS,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  DEFAULT_TOOL_RESULT_BUDGET_CHARS,
  DEFAULT_PRESERVE_RECENT,
} from './types';

export { estimateTokens, tokenCountWithEstimation } from './tokenEstimator';
export { applyToolResultBudget } from './toolResultBudget';
export { snipCompactIfNeeded } from './snipCompact';
export {
  extractFilePaths,
  extractPendingWork,
  extractDecisions,
  buildStructuredSummary,
} from './summaryGenerator';
export {
  getAutoCompactThreshold,
  calculateTokenWarningState,
  autoCompactIfNeeded,
} from './autoCompact';
export { tryReactiveCompact } from './reactiveCompact';

import type {
  CompactMessage,
  CompactionConfig,
  CompactionPipelineResult,
  AutoCompactTrackingState,
} from './types';
import { createDefaultConfig } from './types';
import { applyToolResultBudget } from './toolResultBudget';
import { snipCompactIfNeeded } from './snipCompact';
import { autoCompactIfNeeded } from './autoCompact';

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  readonly messages: readonly CompactMessage[];
  readonly config?: CompactionConfig;
  readonly tracking: AutoCompactTrackingState;
  readonly snipBoundary?: number;
}

/**
 * Run the full compaction pipeline:
 *  1. Tier 1 — Replace oversized tool results
 *  2. Tier 2 — Snip old messages beyond boundary
 *  3. Tier 3 — Auto-compact if token threshold exceeded
 *
 * Returns a CompactionPipelineResult with all tier outputs aggregated.
 */
export function runCompactionPipeline(
  options: PipelineOptions,
): CompactionPipelineResult {
  const config = options.config ?? createDefaultConfig();

  // Tier 1: Tool Result Budget
  const tier1 = applyToolResultBudget(
    options.messages,
    config.microcompactBudgetChars,
  );

  // Tier 2: Snip Compact
  const snipBoundary = options.snipBoundary ?? tier1.messages.length;
  const tier2 = snipCompactIfNeeded(tier1.messages, snipBoundary);

  // Tier 3: Auto Compact
  const tier3 = autoCompactIfNeeded(
    tier2.messages,
    config,
    options.tracking,
    tier2.tokensFreed,
  );

  return Object.freeze({
    compactionResult: tier3.compactionResult,
    consecutiveFailures: tier3.consecutiveFailures,
    toolResultReplacements: tier1.replacements,
    snipTokensFreed: tier2.tokensFreed,
  });
}
