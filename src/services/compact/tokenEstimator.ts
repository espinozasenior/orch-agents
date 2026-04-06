/**
 * Token estimation using chars/4 approximation.
 *
 * Avoids importing a tokenizer library — the approximation is sufficient
 * for threshold checks where exact counts are not required.
 */

import type { CompactMessage, CompactContentBlock } from './types';

/**
 * Estimate token count for a raw text string.
 * Uses the standard chars/4 heuristic.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract the text content from a single content block.
 */
function blockToText(block: CompactContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'tool_use':
      return `${block.name} ${JSON.stringify(block.input)}`;
    case 'tool_result':
      return block.content;
  }
}

/**
 * Estimate token count for a single message (role + all content blocks).
 */
export function estimateMessageTokens(message: CompactMessage): number {
  // ~4 tokens overhead for role/structure
  const overhead = 4;
  const contentTokens = message.content.reduce(
    (sum, block) => sum + estimateTokens(blockToText(block)),
    0,
  );
  return overhead + contentTokens;
}

/**
 * Estimate total token count for an array of messages.
 * If messages carry usage metadata from a prior API call, the
 * input_tokens from the last message is used as a more accurate base.
 */
export function tokenCountWithEstimation(
  messages: readonly CompactMessage[],
): number {
  if (messages.length === 0) return 0;

  // Check if the last message has actual usage data from the API
  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.usage?.input_tokens) {
    return lastMessage.usage.input_tokens;
  }

  // Fall back to chars/4 estimation
  return messages.reduce(
    (total, msg) => total + estimateMessageTokens(msg),
    0,
  );
}
