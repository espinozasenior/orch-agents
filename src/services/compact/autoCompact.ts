/**
 * Tier 3: Auto Compact
 *
 * Checks whether estimated token usage exceeds the context-window threshold
 * and, if so, generates a compaction summary to replace old messages.
 * Includes a circuit breaker that stops retrying after N consecutive failures.
 */

import { randomUUID } from 'node:crypto';
import type {
  CompactMessage,
  CompactionConfig,
  CompactionResult,
  AutoCompactTrackingState,
  TokenWarningState,
} from './types';
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_THRESHOLD_BUFFER_TOKENS,
} from './types';
import { tokenCountWithEstimation, estimateMessageTokens } from './tokenEstimator';
import {
  extractFilePaths,
  extractPendingWork,
  extractDecisions,
  buildStructuredSummary,
} from './summaryGenerator';

// ---------------------------------------------------------------------------
// Threshold helpers
// ---------------------------------------------------------------------------

/**
 * Compute the auto-compact threshold for a given context window.
 */
export function getAutoCompactThreshold(contextWindowTokens: number): number {
  return contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS;
}

/**
 * Calculate current token warning state.
 */
export function calculateTokenWarningState(
  messages: readonly CompactMessage[],
  contextWindowTokens: number,
): TokenWarningState {
  const currentTokens = tokenCountWithEstimation(messages);
  const threshold = contextWindowTokens - WARNING_THRESHOLD_BUFFER_TOKENS;
  return Object.freeze({
    currentTokens,
    threshold,
    exceeded: currentTokens >= threshold,
    buffer: threshold - currentTokens,
  });
}

// ---------------------------------------------------------------------------
// Core compaction
// ---------------------------------------------------------------------------

/**
 * Generate a compacted set of messages: a summary message followed by
 * the most recent N messages preserved verbatim.
 */
function compactConversation(
  messages: readonly CompactMessage[],
  preserveRecent: number,
): CompactionResult {
  const preCompactTokenCount = tokenCountWithEstimation(messages);

  const recentStart = Math.max(0, messages.length - preserveRecent);
  const oldMessages = messages.slice(0, recentStart);
  const recentMessages = messages.slice(recentStart);

  const filesModified = extractFilePaths(oldMessages);
  const pendingWork = extractPendingWork(oldMessages);
  const keyDecisions = extractDecisions(oldMessages);

  const summaryText = buildStructuredSummary({
    messageCount: oldMessages.length,
    filesModified,
    pendingWork,
    keyDecisions,
  });

  const summaryMessage: CompactMessage = {
    uuid: randomUUID(),
    type: 'assistant',
    content: [{ type: 'text', text: summaryText }],
    timestamp: Date.now(),
  };

  const summaryMessages: CompactMessage[] = [summaryMessage, ...recentMessages];
  const postCompactTokenCount = summaryMessages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg),
    0,
  );

  return Object.freeze({
    summaryMessages,
    preCompactTokenCount,
    postCompactTokenCount,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AutoCompactResult {
  readonly compactionResult?: CompactionResult;
  readonly consecutiveFailures?: number;
}

/**
 * Check whether auto-compact should fire and, if so, run it.
 *
 * Respects the circuit breaker: after `maxConsecutiveFailures` consecutive
 * failures, compaction is skipped entirely until the breaker resets.
 */
export function autoCompactIfNeeded(
  messages: readonly CompactMessage[],
  config: CompactionConfig,
  tracking: AutoCompactTrackingState,
  snipTokensFreed: number,
): AutoCompactResult {
  // Circuit breaker check
  if (tracking.consecutiveFailures >= config.maxConsecutiveFailures) {
    return { consecutiveFailures: tracking.consecutiveFailures };
  }

  // Threshold check
  const currentTokens = tokenCountWithEstimation(messages) - snipTokensFreed;
  const threshold = getAutoCompactThreshold(config.contextWindowTokens);

  if (currentTokens < threshold) {
    return {}; // No compaction needed
  }

  // Run compaction
  try {
    const result = compactConversation(messages, config.preserveRecent);

    // Validate that compaction actually helped
    if (result.postCompactTokenCount >= threshold) {
      return { consecutiveFailures: tracking.consecutiveFailures + 1 };
    }

    return { compactionResult: result };
  } catch {
    return { consecutiveFailures: tracking.consecutiveFailures + 1 };
  }
}
