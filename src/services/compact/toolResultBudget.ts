/**
 * Tier 1: Tool Result Budget
 *
 * Replaces oversized tool_result content blocks with a placeholder marker.
 * Preserves tool_use blocks unchanged. Tracks all replacements for
 * potential session restore.
 */

import type {
  CompactMessage,
  ContentReplacementRecord,
} from './types';
import { DEFAULT_TOOL_RESULT_BUDGET_CHARS } from './types';

export interface ToolResultBudgetResult {
  readonly messages: CompactMessage[];
  readonly replacements: readonly ContentReplacementRecord[];
}

/**
 * Scan all messages and replace any tool_result content that exceeds
 * the character budget with a placeholder marker.
 *
 * Messages are cloned shallowly — the original array is not mutated,
 * but content blocks within cloned messages may be replaced.
 */
export function applyToolResultBudget(
  messages: readonly CompactMessage[],
  budget: number = DEFAULT_TOOL_RESULT_BUDGET_CHARS,
): ToolResultBudgetResult {
  const replacements: ContentReplacementRecord[] = [];

  const processed = messages.map((message) => {
    if (message.type !== 'user') return message;

    const hasToolResult = message.content.some(
      (b) => b.type === 'tool_result',
    );
    if (!hasToolResult) return message;

    const newContent = message.content.map((block) => {
      if (block.type !== 'tool_result') return block;

      const size = block.content.length;
      if (size <= budget) return block;

      const marker = `[Content replaced - original was ${size} chars]`;
      replacements.push(
        Object.freeze({
          toolUseId: block.tool_use_id,
          originalSize: size,
          replacementMarker: marker,
          timestamp: Date.now(),
        }),
      );

      return {
        ...block,
        content: marker,
      };
    });

    return { ...message, content: newContent };
  });

  return {
    messages: processed,
    replacements: Object.freeze(replacements),
  };
}
