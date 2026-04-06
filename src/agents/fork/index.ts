/**
 * Fork subagent public API.
 *
 * Re-exports core types and functions for creating fork subagents
 * with prompt cache sharing.
 */

export {
  FORK_BOILERPLATE_TAG,
  FORK_PLACEHOLDER_RESULT,
  FORK_AGENT,
  isForkSubagentEnabled,
  isInForkChild,
  buildForkConversationMessages,
} from './forkSubagent.js';

export type {
  ForkMessage,
  ForkContentBlock,
  ForkTextBlock,
  ForkToolUseBlock,
  ForkToolResultBlock,
  ForkAgentDefinition,
} from './types.js';

export type { AgentEntry } from './forkRegistry.js';

export {
  createCompositeAgentRegistry,
  getDefaultProgrammaticAgents,
  getForkAgentDefinition,
  shouldUseFork,
  buildForkMessages,
} from './forkRegistry.js';
