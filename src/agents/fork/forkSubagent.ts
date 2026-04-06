/**
 * Fork subagent with prompt cache sharing.
 *
 * The critical invariant is byte-identical API request prefixes across
 * all fork children from the same parent. This is achieved by replacing
 * every tool_result block's content with a constant placeholder string.
 * Only the final directive message differs between forks.
 */

import { randomUUID } from 'node:crypto';
import type {
  ForkAgentDefinition,
  ForkContentBlock,
  ForkMessage,
} from './types';

/** XML tag used to mark fork boilerplate in message history. */
export const FORK_BOILERPLATE_TAG = 'fork-context';

/** Constant placeholder replacing all tool_result content for cache sharing. */
export const FORK_PLACEHOLDER_RESULT =
  'Fork started \u2014 processing in background';

/** Built-in fork agent definition. */
export const FORK_AGENT: ForkAgentDefinition = {
  agentType: 'fork',
  whenToUse:
    'Implicit fork \u2014 context inheritance. Triggered by omitting subagent_type.',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  getSystemPrompt: () => '',
};

/**
 * Returns whether fork subagent creation is enabled.
 *
 * Fork is disabled in coordinator mode (where fresh agents are always
 * spawned) and in non-interactive sessions (where background tasks
 * cannot deliver task-notifications).
 */
export function isForkSubagentEnabled(
  isCoordinator: boolean,
  isNonInteractive: boolean,
): boolean {
  if (isCoordinator) return false;
  if (isNonInteractive) return false;
  return true;
}

/**
 * Detects whether the current agent is already a fork child by
 * scanning message history for the fork boilerplate tag.
 *
 * Fork children cannot fork again (depth = 1).
 */
export function isInForkChild(messages: ForkMessage[]): boolean {
  const openTag = `<${FORK_BOILERPLATE_TAG}>`;
  for (const message of messages) {
    if (message.type !== 'user') continue;
    for (const block of message.content) {
      if (block.type === 'text' && block.text.includes(openTag)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Builds fork conversation messages from parent history.
 *
 * All fork children from the same parent produce byte-identical message
 * prefixes. The algorithm:
 *   1. Copy all parent messages
 *   2. Replace every tool_result content with FORK_PLACEHOLDER_RESULT
 *   3. Keep assistant messages and tool_use blocks verbatim
 *   4. Append boilerplate tag + directive as final user message
 */
export function buildForkConversationMessages(
  parentMessages: ForkMessage[],
  directive: string,
): ForkMessage[] {
  const forkMessages: ForkMessage[] = [];

  for (const message of parentMessages) {
    if (message.type === 'user') {
      const clonedContent: ForkContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          clonedContent.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: FORK_PLACEHOLDER_RESULT,
          });
        } else {
          clonedContent.push(block);
        }
      }
      forkMessages.push({
        uuid: message.uuid,
        type: 'user',
        content: clonedContent,
      });
    } else {
      forkMessages.push(message);
    }
  }

  // Append directive with boilerplate tag
  const directiveMessage: ForkMessage = {
    uuid: randomUUID(),
    type: 'user',
    content: [
      {
        type: 'text',
        text: `<${FORK_BOILERPLATE_TAG}>Context inherited from parent</${FORK_BOILERPLATE_TAG}>`,
      },
      { type: 'text', text: directive },
    ],
  };
  forkMessages.push(directiveMessage);

  return forkMessages;
}
