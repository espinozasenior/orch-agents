/**
 * Core types for the fork subagent system.
 *
 * Fork subagents inherit parent conversation context and share prompt
 * cache via byte-identical API request prefixes.
 */

export interface ForkMessage {
  uuid: string;
  type: 'user' | 'assistant' | 'system';
  content: ForkContentBlock[];
}

export type ForkContentBlock =
  | ForkTextBlock
  | ForkToolUseBlock
  | ForkToolResultBlock;

export interface ForkTextBlock {
  type: 'text';
  text: string;
}

export interface ForkToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ForkToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ForkAgentDefinition {
  agentType: 'fork';
  whenToUse: string;
  tools: string[];
  maxTurns: number;
  model: 'inherit';
  permissionMode: 'bubble';
  source: 'built-in';
  getSystemPrompt: () => string;
}
