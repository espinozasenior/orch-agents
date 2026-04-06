import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  queryLoop,
  DEFAULT_MAX_TURNS,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  OUTPUT_RECOVERY_MESSAGE,
} from '../../src/query/queryLoop.js';
import type {
  QueryParams,
  QueryEvent,
  CompactionResult,
  StopHookResult,
  BudgetDecision,
} from '../../src/query/queryLoop.js';
import type { Terminal, Continue } from '../../src/query/transitions.js';
import type { QueryMessage } from '../../src/query/state.js';
import { createTestDeps } from '../../src/query/deps.js';
import type { ModelEvent } from '../../src/query/deps.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Consume the async generator, collecting yielded events and the return value. */
async function consumeLoop(
  params: QueryParams,
): Promise<{ events: QueryEvent[]; terminal: Terminal; transitions: Continue[] }> {
  const events: QueryEvent[] = [];
  const transitions: Continue[] = [];
  const gen = queryLoop(params);

  let result = await gen.next();
  while (!result.done) {
    events.push(result.value);
    result = await gen.next();
  }

  // Walk through events to track transitions — we infer from the loop
  // but transitions are embedded in state; for test purposes we track
  // them via the events pattern.
  return { events, terminal: result.value, transitions };
}

/** Build minimal QueryParams with scripted model responses. */
function makeParams(
  responses: ModelEvent[][],
  overrides?: Partial<QueryParams>,
): QueryParams {
  const userMessage: QueryMessage = {
    uuid: 'user-1',
    type: 'user',
    content: 'Hello',
  };
  return {
    messages: [userMessage],
    systemPrompt: 'You are a helpful assistant.',
    deps: createTestDeps(responses),
    ...overrides,
  };
}

/** Create a text-only model event. */
function textEvent(content: string): ModelEvent {
  return { type: 'text', content };
}

/** Create a tool_use model event. */
function toolUseEvent(name: string, input: Record<string, unknown> = {}): ModelEvent {
  return { type: 'tool_use', id: `tool-${name}`, name, input };
}

/** Create a max_output_tokens error event. */
function maxOutputTokensEvent(): ModelEvent {
  return { type: 'error', apiError: 'max_output_tokens' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueryLoop', () => {
  describe('normal completion', () => {
    it('should complete normally when model returns text only', async () => {
      const params = makeParams([[textEvent('Hello, world!')]]);
      const { terminal } = await consumeLoop(params);
      assert.equal(terminal.reason, 'completed');
    });

    it('should yield stream_request_start before calling model', async () => {
      const params = makeParams([[textEvent('Hi')]]);
      const { events } = await consumeLoop(params);
      assert.equal(events[0].type, 'stream_request_start');
    });

    it('should yield assistant_message events for text responses', async () => {
      const params = makeParams([[textEvent('Response text')]]);
      const { events } = await consumeLoop(params);
      const assistantEvents = events.filter((e) => e.type === 'assistant_message');
      assert.equal(assistantEvents.length, 1);
    });
  });

  describe('tool_use transition', () => {
    it('should loop on tool_use and re-query', async () => {
      const params = makeParams([
        [toolUseEvent('read_file', { path: '/foo' })],
        [textEvent('File contents are...')],
      ]);
      const { terminal, events } = await consumeLoop(params);

      // Should have two stream_request_start events (two model calls)
      const starts = events.filter((e) => e.type === 'stream_request_start');
      assert.equal(starts.length, 2);
      assert.equal(terminal.reason, 'completed');
    });

    it('should yield tool_result events for executed tools', async () => {
      const toolMessages: QueryMessage[] = [
        { uuid: 'tool-result-1', type: 'user', content: 'file content here' },
      ];
      const params = makeParams(
        [
          [toolUseEvent('read_file')],
          [textEvent('Done')],
        ],
        {
          executeTool: async () => ({ messages: toolMessages }),
        },
      );
      const { events } = await consumeLoop(params);
      const toolResults = events.filter((e) => e.type === 'tool_result');
      assert.equal(toolResults.length, 1);
    });

    it('should handle multiple tool_use iterations', async () => {
      const params = makeParams([
        [toolUseEvent('tool_a')],
        [toolUseEvent('tool_b')],
        [toolUseEvent('tool_c')],
        [textEvent('All done')],
      ]);
      const { terminal, events } = await consumeLoop(params);
      const starts = events.filter((e) => e.type === 'stream_request_start');
      assert.equal(starts.length, 4);
      assert.equal(terminal.reason, 'completed');
    });
  });

  describe('maxTurns enforcement', () => {
    it('should enforce maxTurns hard limit', async () => {
      // Generate enough tool_use responses to exceed the limit
      const responses: ModelEvent[][] = Array.from({ length: 10 }, () => [
        toolUseEvent('bash'),
      ]);
      const params = makeParams(responses, { maxTurns: 5 });
      const { terminal } = await consumeLoop(params);
      assert.equal(terminal.reason, 'max_turns');
    });

    it('should use DEFAULT_MAX_TURNS when not specified', () => {
      assert.equal(DEFAULT_MAX_TURNS, 200);
    });

    it('should complete before maxTurns if model stops using tools', async () => {
      const params = makeParams(
        [
          [toolUseEvent('bash')],
          [textEvent('Done')],
        ],
        { maxTurns: 50 },
      );
      const { terminal } = await consumeLoop(params);
      assert.equal(terminal.reason, 'completed');
    });
  });

  describe('max_output_tokens recovery', () => {
    it('should recover from max_output_tokens up to 3 times', async () => {
      const params = makeParams([
        [maxOutputTokensEvent()],
        [maxOutputTokensEvent()],
        [maxOutputTokensEvent()],
        [textEvent('Finally done')],
      ]);
      const { terminal } = await consumeLoop(params);
      assert.equal(terminal.reason, 'completed');
    });

    it('should surface error after exhausting recovery attempts', async () => {
      const params = makeParams([
        [maxOutputTokensEvent()],
        [maxOutputTokensEvent()],
        [maxOutputTokensEvent()],
        [maxOutputTokensEvent()], // 4th time — exhausted
      ]);
      const { terminal, events } = await consumeLoop(params);
      // After 3 recoveries, the 4th error is surfaced and loop completes
      assert.equal(terminal.reason, 'completed');
      const errorEvents = events.filter((e) => e.type === 'error_message');
      assert.ok(errorEvents.length >= 1, 'Should surface at least one error');
    });

    it('should reset recovery count on tool_use success', async () => {
      const params = makeParams([
        [maxOutputTokensEvent()],              // recovery 1
        [toolUseEvent('bash')],                 // tool_use resets count
        [maxOutputTokensEvent()],              // recovery 1 (reset)
        [maxOutputTokensEvent()],              // recovery 2
        [maxOutputTokensEvent()],              // recovery 3
        [textEvent('Done')],
      ]);
      const { terminal } = await consumeLoop(params);
      assert.equal(terminal.reason, 'completed');
    });

    it('should have correct recovery limit constant', () => {
      assert.equal(MAX_OUTPUT_TOKENS_RECOVERY_LIMIT, 3);
    });

    it('should have correct recovery message constant', () => {
      assert.ok(OUTPUT_RECOVERY_MESSAGE.includes('Resume directly'));
      assert.ok(OUTPUT_RECOVERY_MESSAGE.includes('no recap'));
    });
  });

  describe('abort signal', () => {
    it('should return aborted_streaming when signal fires during model call', async () => {
      const ac = new AbortController();
      // Create a model that aborts mid-stream
      const deps = createTestDeps([]);
      const abortingDeps = {
        ...deps,
        async *callModel(): AsyncGenerator<ModelEvent> {
          yield { type: 'text' as const, content: 'partial...' };
          ac.abort();
          yield { type: 'text' as const, content: 'more' };
        },
      };
      const params = makeParams([], {
        deps: abortingDeps,
        abortSignal: ac.signal,
      });
      const { terminal, events } = await consumeLoop(params);
      assert.equal(terminal.reason, 'aborted_streaming');
      const interruptions = events.filter((e) => e.type === 'interruption');
      assert.equal(interruptions.length, 1);
    });

    it('should return aborted_tools when signal fires during tool execution', async () => {
      const ac = new AbortController();
      const params = makeParams(
        [
          [toolUseEvent('slow_tool')],
          [textEvent('Done')],
        ],
        {
          abortSignal: ac.signal,
          executeTool: async () => {
            ac.abort();
            return { messages: [] };
          },
        },
      );
      const { terminal } = await consumeLoop(params);
      assert.equal(terminal.reason, 'aborted_tools');
    });
  });

  describe('model error', () => {
    it('should return model_error on thrown exception', async () => {
      const deps = createTestDeps([]);
      const errorDeps = {
        ...deps,
        async *callModel(): AsyncGenerator<ModelEvent> {
          throw new Error('API rate limit exceeded');
        },
      };
      const params = makeParams([], { deps: errorDeps });
      const { terminal, events } = await consumeLoop(params);
      assert.equal(terminal.reason, 'model_error');
      assert.ok(terminal.error instanceof Error);
      assert.equal((terminal.error as Error).message, 'API rate limit exceeded');
      const errorEvents = events.filter((e) => e.type === 'error_message');
      assert.equal(errorEvents.length, 1);
    });
  });

  describe('compaction (P0 integration point)', () => {
    it('should continue with compact_retry when compaction occurs', async () => {
      let compactCalled = 0;
      const compactedMessage: QueryMessage = {
        uuid: 'compacted-1',
        type: 'system',
        content: '[compacted]',
      };
      const compact = async (messages: QueryMessage[]): Promise<CompactionResult> => {
        compactCalled++;
        if (compactCalled === 1) {
          return { compacted: true, messages: [compactedMessage] };
        }
        return { compacted: false, messages };
      };
      const params = makeParams([[textEvent('Hi')]], { compact });
      const { terminal } = await consumeLoop(params);
      assert.equal(terminal.reason, 'completed');
      assert.equal(compactCalled, 2); // Once compacted, once passed through
    });
  });

  describe('blocking limit', () => {
    it('should return blocking_limit when at token boundary', async () => {
      const params = makeParams([[textEvent('Hi')]], {
        isAtBlockingLimit: () => true,
      });
      const { terminal, events } = await consumeLoop(params);
      assert.equal(terminal.reason, 'blocking_limit');
      const errorEvents = events.filter((e) => e.type === 'error_message');
      assert.equal(errorEvents.length, 1);
    });
  });

  describe('stop hooks (integration point)', () => {
    it('should return stop_hook_prevented when hook prevents continuation', async () => {
      const params = makeParams([[textEvent('Hi')]], {
        handleStopHooks: async (): Promise<StopHookResult> => ({
          preventContinuation: true,
          blockingErrors: [],
        }),
      });
      const { terminal } = await consumeLoop(params);
      assert.equal(terminal.reason, 'stop_hook_prevented');
    });

    it('should continue with stop_hook_blocking when hook has errors', async () => {
      let hookCalls = 0;
      const blockingError: QueryMessage = {
        uuid: 'hook-err-1',
        type: 'system',
        content: 'Hook found issue',
      };
      const params = makeParams(
        [
          [textEvent('attempt 1')],
          [textEvent('attempt 2')],
        ],
        {
          handleStopHooks: async (): Promise<StopHookResult> => {
            hookCalls++;
            if (hookCalls === 1) {
              return { preventContinuation: false, blockingErrors: [blockingError] };
            }
            return { preventContinuation: false, blockingErrors: [] };
          },
        },
      );
      const { terminal } = await consumeLoop(params);
      assert.equal(terminal.reason, 'completed');
      assert.equal(hookCalls, 2);
    });
  });

  describe('budget continuation (P3 integration point)', () => {
    it('should continue with budget_continuation when under budget', async () => {
      let budgetCalls = 0;
      const params = makeParams(
        [
          [textEvent('partial work')],
          [textEvent('more work')],
        ],
        {
          checkBudget: (): BudgetDecision => {
            budgetCalls++;
            if (budgetCalls === 1) {
              return { action: 'continue', nudgeMessage: 'Keep going, budget remaining.' };
            }
            return { action: 'stop' };
          },
        },
      );
      const { terminal } = await consumeLoop(params);
      assert.equal(terminal.reason, 'completed');
      assert.equal(budgetCalls, 2);
    });
  });

  describe('state immutability', () => {
    it('should not mutate messages array across iterations', async () => {
      const originalMessages: QueryMessage[] = [
        { uuid: 'msg-1', type: 'user', content: 'Hello' },
      ];
      const messagesCopy = [...originalMessages];
      const params: QueryParams = {
        messages: originalMessages,
        systemPrompt: 'Test',
        deps: createTestDeps([
          [toolUseEvent('test_tool')],
          [textEvent('Done')],
        ]),
      };
      await consumeLoop(params);
      // Original array should not have been mutated
      assert.deepEqual(originalMessages, messagesCopy);
    });
  });

  describe('P11 observability — emitEvent', () => {
    it('emits a terminal QueryTransition on normal completion', async () => {
      const events: Array<{ type: string; kind?: string; reason?: string }> = [];
      const params = makeParams([[textEvent('hi')]], {
        emitEvent: (e) => events.push(e),
        taskId: 'task-1',
      });
      await consumeLoop(params);
      const terminals = events.filter((e) => e.type === 'QueryTransition' && e.kind === 'terminal');
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].reason, 'completed');
    });

    it('emits continue QueryTransition events on tool_use iterations', async () => {
      const events: Array<{ type: string; kind?: string; reason?: string }> = [];
      const params = makeParams(
        [
          [toolUseEvent('read_file')],
          [toolUseEvent('read_file')],
          [textEvent('done')],
        ],
        { emitEvent: (e) => events.push(e) },
      );
      await consumeLoop(params);
      const continues = events.filter((e) => e.type === 'QueryTransition' && e.kind === 'continue');
      // Two tool_use transitions before the terminal
      assert.equal(continues.length, 2);
      assert.equal(continues[0].reason, 'tool_use');
    });

    it('emits BudgetContinuation event when budget continues the loop', async () => {
      let budgetCalls = 0;
      const events: Array<{ type: string }> = [];
      const params = makeParams(
        [
          [textEvent('partial')],
          [textEvent('done')],
        ],
        {
          emitEvent: (e) => events.push(e),
          checkBudget: (): BudgetDecision => {
            budgetCalls++;
            if (budgetCalls === 1) {
              return { action: 'continue', nudgeMessage: 'keep going' };
            }
            return { action: 'stop' };
          },
        },
      );
      await consumeLoop(params);
      assert.ok(events.some((e) => e.type === 'BudgetContinuation'));
    });

    it('emits a terminal QueryTransition on max_turns', async () => {
      const events: Array<{ type: string; kind?: string; reason?: string }> = [];
      const responses: ModelEvent[][] = Array.from({ length: 10 }, () => [toolUseEvent('bash')]);
      const params = makeParams(responses, {
        maxTurns: 3,
        emitEvent: (e) => events.push(e),
      });
      await consumeLoop(params);
      const terminal = events.find((e) => e.type === 'QueryTransition' && e.kind === 'terminal');
      assert.ok(terminal);
      assert.equal(terminal!.reason, 'max_turns');
    });
  });

  describe('multiple events per model turn', () => {
    it('should handle text followed by tool_use in same turn', async () => {
      const params = makeParams([
        [textEvent('Let me read that file'), toolUseEvent('read_file', { path: '/x' })],
        [textEvent('Here are the contents')],
      ]);
      const { terminal, events } = await consumeLoop(params);
      assert.equal(terminal.reason, 'completed');
      const assistantMsgs = events.filter((e) => e.type === 'assistant_message');
      // Turn 1: text + tool_use = 2 messages, Turn 2: text = 1 message
      assert.equal(assistantMsgs.length, 3);
    });
  });
});
