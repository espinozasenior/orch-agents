/**
 * Tier 2: Snip Compact
 *
 * Truncates old messages beyond a configurable snip boundary.
 * Runs BEFORE auto-compact to reduce the input to the summarisation call.
 */

import { randomUUID } from 'node:crypto';
import type { CompactMessage, SnipCompactResult } from './types';
import { estimateMessageTokens } from './tokenEstimator';

/**
 * Remove messages older than the snip boundary index.
 *
 * @param messages  Full conversation history
 * @param snipBoundary  Number of recent messages to keep.
 *   If the array is shorter than this, nothing is snipped.
 * @returns SnipCompactResult with kept messages, freed tokens,
 *   and an optional boundary marker message.
 */
export function snipCompactIfNeeded(
  messages: readonly CompactMessage[],
  snipBoundary: number,
): SnipCompactResult {
  if (messages.length <= snipBoundary) {
    return { messages: [...messages], tokensFreed: 0 };
  }

  const snipPoint = messages.length - snipBoundary;
  const removedMessages = messages.slice(0, snipPoint);
  const keptMessages = messages.slice(snipPoint);

  const tokensFreed = removedMessages.reduce(
    (sum, msg) => sum + estimateMessageTokens(msg),
    0,
  );

  const boundaryMessage: CompactMessage = {
    uuid: randomUUID(),
    type: 'system',
    content: [
      {
        type: 'text',
        text:
          `[Snip boundary: ${removedMessages.length} older messages removed, ` +
          `~${tokensFreed} tokens freed]`,
      },
    ],
    timestamp: Date.now(),
  };

  return {
    messages: [boundaryMessage, ...keptMessages],
    tokensFreed,
    boundaryMessage,
  };
}
