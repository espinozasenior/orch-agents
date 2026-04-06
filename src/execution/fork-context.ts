/**
 * Fork context helpers for simple-executor (P5 — prompt cache sharing).
 *
 * These functions bridge the fork subagent module (src/agents/fork) with
 * the execution layer. They convert agent prompt/response pairs into
 * ForkMessage entries and serialize fork message arrays into text
 * prefixes that the SDK executor can prepend to the agent prompt.
 *
 * The goal is prompt cache sharing: all fork children from the same
 * parent produce byte-identical message prefixes (tool_result content
 * replaced with a constant placeholder). Only the per-child directive
 * differs — maximizing cache hits.
 *
 * See: original Claude Code source — src/tools/AgentTool/forkSubagent.ts
 */

import { randomUUID } from 'node:crypto';
import type { ForkMessage } from '../agents/fork/types';

// ---------------------------------------------------------------------------
// Fork history recording
// ---------------------------------------------------------------------------

/**
 * Records an agent's prompt/response pair into fork history.
 *
 * Each pair is stored as a user message (prompt) + assistant message
 * (response), matching the original Claude Code fork pattern where
 * parent messages are carried forward to fork children.
 */
export function recordForkHistory(
  history: ForkMessage[],
  prompt: string,
  response: string,
): void {
  // User message: the agent's prompt
  history.push({
    uuid: randomUUID(),
    type: 'user',
    content: [{ type: 'text', text: prompt }],
  });

  // Assistant message: the agent's response
  if (response) {
    history.push({
      uuid: randomUUID(),
      type: 'assistant',
      content: [{ type: 'text', text: response }],
    });
  }
}

// ---------------------------------------------------------------------------
// Fork message serialization
// ---------------------------------------------------------------------------

/**
 * Serializes fork messages into a text prefix for the SDK executor.
 *
 * The SDK executor receives a flat prompt string, so we serialize the
 * fork conversation into a structured text format that carries the
 * parent context. The boilerplate tag is preserved so isInForkChild()
 * detects the fork and prevents recursive forking (depth = 1).
 *
 * This follows the original Claude Code pattern where fork children
 * receive byte-identical message prefixes for prompt cache sharing.
 */
export function serializeForkContext(forkMessages: ForkMessage[]): string {
  const parts: string[] = [];

  for (const msg of forkMessages) {
    const role = msg.type === 'user' ? 'Human' : msg.type === 'assistant' ? 'Assistant' : 'System';
    const textParts: string[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_result') {
        textParts.push(`[Tool Result: ${block.content}]`);
      } else if (block.type === 'tool_use') {
        textParts.push(`[Tool Use: ${block.name}]`);
      }
    }

    if (textParts.length > 0) {
      parts.push(`${role}: ${textParts.join('\n')}`);
    }
  }

  return parts.join('\n\n');
}
