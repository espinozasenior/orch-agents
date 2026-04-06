/**
 * Tier 4: Reactive Compact (Emergency)
 *
 * Fires only when the API returns a prompt_too_long error.
 * Uses a single-shot guard to prevent infinite retry loops.
 */

import { randomUUID } from 'node:crypto';
import type { CompactMessage, CompactionResult } from './types';
import { DEFAULT_PRESERVE_RECENT } from './types';
import { tokenCountWithEstimation, estimateMessageTokens } from './tokenEstimator';
import {
  extractFilePaths,
  extractPendingWork,
  extractDecisions,
  buildStructuredSummary,
} from './summaryGenerator';

/**
 * Emergency compaction — generates a summary from the full conversation.
 * More aggressive than auto-compact: preserves fewer messages if needed.
 */
function emergencyCompact(
  messages: readonly CompactMessage[],
  preserveRecent: number,
): CompactionResult {
  const preCompactTokenCount = tokenCountWithEstimation(messages);

  const recentStart = Math.max(0, messages.length - preserveRecent);
  const oldMessages = messages.slice(0, recentStart);
  const recentMessages = messages.slice(recentStart);

  const summaryText = buildStructuredSummary({
    messageCount: oldMessages.length,
    filesModified: extractFilePaths(oldMessages),
    pendingWork: extractPendingWork(oldMessages),
    keyDecisions: extractDecisions(oldMessages),
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

/**
 * Attempt reactive compaction. Returns null if:
 *  - The single-shot guard has already been triggered (hasAttempted = true)
 *  - The compaction itself fails
 */
export function tryReactiveCompact(
  hasAttempted: boolean,
  messages: readonly CompactMessage[],
  preserveRecent: number = DEFAULT_PRESERVE_RECENT,
): CompactionResult | null {
  // Single-shot guard
  if (hasAttempted) {
    return null;
  }

  try {
    return emergencyCompact(messages, preserveRecent);
  } catch (_error: unknown) {
    return null;
  }
}
