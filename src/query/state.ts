// ---------------------------------------------------------------------------
// P1 — Query Loop State
// ---------------------------------------------------------------------------

import type { Continue } from './transitions.js';

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface ToolUseBlockRef {
  id: string;
  name: string;
}

export interface QueryMessage {
  uuid: string;
  type: 'user' | 'assistant' | 'system';
  content: string;
  toolUseBlocks?: ToolUseBlockRef[];
  apiError?: string;
  isMeta?: boolean;
}

// ---------------------------------------------------------------------------
// Loop state (immutable between transitions)
// ---------------------------------------------------------------------------

export interface QueryLoopState {
  messages: QueryMessage[];
  turnCount: number;
  maxOutputRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  transition: Continue | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInitialState(messages: QueryMessage[]): QueryLoopState {
  return {
    messages: [...messages],
    turnCount: 1,
    maxOutputRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    transition: undefined,
  };
}
