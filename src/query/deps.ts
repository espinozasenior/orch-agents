// ---------------------------------------------------------------------------
// P1 — Dependency Injection for Query Loop
// ---------------------------------------------------------------------------

import type { QueryMessage } from './state.js';

// ---------------------------------------------------------------------------
// Event types yielded by the model stream
// ---------------------------------------------------------------------------

export interface ModelTextEvent {
  type: 'text';
  content: string;
}

export interface ModelToolUseEvent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelErrorEvent {
  type: 'error';
  apiError: string;
}

export type ModelEvent = ModelTextEvent | ModelToolUseEvent | ModelErrorEvent;

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

export interface QueryDeps {
  /** Stream model responses for the given messages. */
  callModel: (
    messages: QueryMessage[],
    systemPrompt: string,
  ) => AsyncGenerator<ModelEvent>;
  /** Generate a unique identifier. */
  uuid: () => string;
  /** Estimate token count for a message array. */
  estimateTokens: (messages: QueryMessage[]) => number;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create deps that replay scripted model responses.
 * Each inner array is one "turn" of model output events.
 */
export function createTestDeps(responses: ModelEvent[][]): QueryDeps {
  let callIndex = 0;

  return {
    async *callModel(): AsyncGenerator<ModelEvent> {
      const events = responses[callIndex];
      if (!events) {
        throw new Error(`No scripted response at index ${callIndex}`);
      }
      callIndex++;
      for (const event of events) {
        yield event;
      }
    },
    uuid: (() => {
      let counter = 0;
      return () => `test-uuid-${++counter}`;
    })(),
    estimateTokens: (messages: QueryMessage[]) =>
      messages.reduce((sum, m) => sum + m.content.length, 0),
  };
}
