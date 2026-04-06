/**
 * Tests for QueryLoopFactory — P1 integration wiring.
 *
 * TDD London School: mock all dependencies, verify delegation.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  createQueryLoopParams,
  queryMessageToCompact,
  compactMessageToQuery,
  type QueryLoopFactoryDeps,
} from '../../src/query/queryLoopFactory.js';
import type { QueryMessage } from '../../src/query/state.js';

// ---------------------------------------------------------------------------
// Message adapter tests
// ---------------------------------------------------------------------------

describe('queryMessageToCompact', () => {
  it('should convert text-only QueryMessage to CompactMessage with text block', () => {
    const msg: QueryMessage = {
      uuid: 'u1',
      type: 'user',
      content: 'Hello world',
    };

    const result = queryMessageToCompact(msg);

    assert.equal(result.uuid, 'u1');
    assert.equal(result.type, 'user');
    assert.equal(result.content.length, 1);
    assert.deepEqual(result.content[0], { type: 'text', text: 'Hello world' });
    assert.equal(typeof result.timestamp, 'number');
  });

  it('should include tool_use blocks when present', () => {
    const msg: QueryMessage = {
      uuid: 'u2',
      type: 'assistant',
      content: '',
      toolUseBlocks: [{ id: 'tool-1', name: 'read_file' }],
    };

    const result = queryMessageToCompact(msg);

    // Empty content string produces no text block
    assert.equal(result.content.length, 1);
    const toolBlock = result.content[0];
    assert.equal(toolBlock.type, 'tool_use');
    if (toolBlock.type === 'tool_use') {
      assert.equal(toolBlock.id, 'tool-1');
      assert.equal(toolBlock.name, 'read_file');
    }
  });

  it('should include both text and tool_use blocks', () => {
    const msg: QueryMessage = {
      uuid: 'u3',
      type: 'assistant',
      content: 'Some text',
      toolUseBlocks: [{ id: 'tool-2', name: 'bash' }],
    };

    const result = queryMessageToCompact(msg);

    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[1].type, 'tool_use');
  });
});

describe('compactMessageToQuery', () => {
  it('should convert text blocks to string content', () => {
    const compact = {
      uuid: 'c1',
      type: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Hello' }],
    };

    const result = compactMessageToQuery(compact);

    assert.equal(result.uuid, 'c1');
    assert.equal(result.type, 'assistant');
    assert.equal(result.content, 'Hello');
  });

  it('should concatenate multiple text blocks with newlines', () => {
    const compact = {
      uuid: 'c2',
      type: 'user' as const,
      content: [
        { type: 'text' as const, text: 'Part 1' },
        { type: 'text' as const, text: 'Part 2' },
      ],
    };

    const result = compactMessageToQuery(compact);

    assert.equal(result.content, 'Part 1\nPart 2');
  });

  it('should include tool_result content in text', () => {
    const compact = {
      uuid: 'c3',
      type: 'system' as const,
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: 'tu-1',
          content: 'file contents here',
        },
      ],
    };

    const result = compactMessageToQuery(compact);

    assert.equal(result.content, 'file contents here');
  });

  it('should skip tool_use blocks in text extraction', () => {
    const compact = {
      uuid: 'c4',
      type: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'Before' },
        { type: 'tool_use' as const, id: 'tu-1', name: 'bash', input: {} },
        { type: 'text' as const, text: 'After' },
      ],
    };

    const result = compactMessageToQuery(compact);

    assert.equal(result.content, 'Before\nAfter');
  });
});

// ---------------------------------------------------------------------------
// Factory callback tests
// ---------------------------------------------------------------------------

describe('createQueryLoopParams', () => {
  const baseDeps: QueryLoopFactoryDeps = {
    contextWindowTokens: 200_000,
    estimateTokens: (msgs: QueryMessage[]) =>
      msgs.reduce((sum, m) => sum + m.content.length, 0),
  };

  describe('compact callback', () => {
    it('should return compacted=false when pipeline finds nothing to compact', async () => {
      const callbacks = createQueryLoopParams({
        ...baseDeps,
        enableCompaction: true,
      });

      const messages: QueryMessage[] = [
        { uuid: 'u1', type: 'user', content: 'Hello' },
      ];

      const result = await callbacks.compact(messages);

      assert.equal(result.compacted, false);
      assert.deepEqual(result.messages, messages);
    });

    it('should pass messages through unchanged when compaction disabled', async () => {
      const callbacks = createQueryLoopParams({
        ...baseDeps,
        enableCompaction: false,
      });

      const messages: QueryMessage[] = [
        { uuid: 'u1', type: 'user', content: 'Hello' },
      ];

      const result = await callbacks.compact(messages);

      assert.equal(result.compacted, false);
      assert.deepEqual(result.messages, messages);
    });

    it('should convert QueryMessage to CompactMessage format for pipeline', async () => {
      // Verify the adapter is called correctly by checking the round-trip
      const callbacks = createQueryLoopParams({
        ...baseDeps,
        enableCompaction: true,
      });

      const messages: QueryMessage[] = [
        { uuid: 'u1', type: 'user', content: 'Hello world' },
        { uuid: 'u2', type: 'assistant', content: 'Response text' },
      ];

      // With short messages, pipeline won't compact — but it should not error
      const result = await callbacks.compact(messages);
      assert.equal(result.compacted, false);
      assert.equal(result.messages.length, 2);
    });
  });

  describe('checkBudget callback', () => {
    it('should return stop when no budget configured', () => {
      const callbacks = createQueryLoopParams({
        ...baseDeps,
        tokenBudget: undefined,
      });

      const result = callbacks.checkBudget();

      assert.equal(result.action, 'stop');
    });

    it('should return continue with nudge when under budget threshold', () => {
      let turnTokens = 1000;
      const callbacks = createQueryLoopParams({
        ...baseDeps,
        tokenBudget: 100_000,
        getGlobalTurnTokens: () => turnTokens,
      });

      const result = callbacks.checkBudget();

      assert.equal(result.action, 'continue');
      assert.ok(result.nudgeMessage);
      assert.ok(result.nudgeMessage!.includes('1%'));
    });

    it('should return stop when over budget threshold', () => {
      let turnTokens = 95_000;
      const callbacks = createQueryLoopParams({
        ...baseDeps,
        tokenBudget: 100_000,
        getGlobalTurnTokens: () => turnTokens,
      });

      const result = callbacks.checkBudget();

      assert.equal(result.action, 'stop');
    });

    it('should track state across calls via internal BudgetTracker', () => {
      let turnTokens = 10_000;
      const callbacks = createQueryLoopParams({
        ...baseDeps,
        tokenBudget: 100_000,
        getGlobalTurnTokens: () => turnTokens,
      });

      // First call: continue
      const first = callbacks.checkBudget();
      assert.equal(first.action, 'continue');

      // Advance tokens significantly
      turnTokens = 50_000;
      const second = callbacks.checkBudget();
      assert.equal(second.action, 'continue');

      // Exceed 90% threshold
      turnTokens = 91_000;
      const third = callbacks.checkBudget();
      assert.equal(third.action, 'stop');
    });
  });

  describe('executeTool callback', () => {
    it('should return empty messages when no tool registry', async () => {
      const callbacks = createQueryLoopParams({
        ...baseDeps,
        toolRegistry: undefined,
      });

      const result = await callbacks.executeTool([
        { id: 'tu-1', name: 'bash', input: { command: 'echo hi' } },
      ]);

      assert.deepEqual(result.messages, []);
    });

    it('should delegate to runTools when registry provided', async () => {
      const executeMock = mock.fn(async () => ({
        content: 'tool output',
        is_error: false,
      }));

      const registry = new Map<string, import('../../src/services/tools/types.js').ToolDefinition>();
      registry.set('test_tool', {
        name: 'test_tool',
        isConcurrencySafe: () => true,
        execute: executeMock,
      });

      const callbacks = createQueryLoopParams({
        ...baseDeps,
        toolRegistry: registry,
      });

      const result = await callbacks.executeTool([
        { id: 'tu-1', name: 'test_tool', input: { arg: 'value' } },
      ]);

      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].content, 'tool output');
      assert.equal(executeMock.mock.calls.length, 1);
    });

    it('should handle unknown tool gracefully', async () => {
      const registry = new Map<string, import('../../src/services/tools/types.js').ToolDefinition>();

      const callbacks = createQueryLoopParams({
        ...baseDeps,
        toolRegistry: registry,
      });

      const result = await callbacks.executeTool([
        { id: 'tu-1', name: 'nonexistent', input: {} },
      ]);

      assert.equal(result.messages.length, 1);
      assert.ok(result.messages[0].content.includes('Unknown tool'));
    });
  });

  describe('isAtBlockingLimit callback', () => {
    it('should return true when tokens exceed 95% of context window', () => {
      const callbacks = createQueryLoopParams({
        ...baseDeps,
        contextWindowTokens: 1000,
      });

      // estimateTokens sums content.length, so 960 chars = 960 "tokens"
      const messages: QueryMessage[] = [
        { uuid: 'u1', type: 'user', content: 'x'.repeat(960) },
      ];

      const result = callbacks.isAtBlockingLimit(messages, baseDeps.estimateTokens);

      assert.equal(result, true);
    });

    it('should return false when under 95% of context window', () => {
      const callbacks = createQueryLoopParams({
        ...baseDeps,
        contextWindowTokens: 1000,
      });

      const messages: QueryMessage[] = [
        { uuid: 'u1', type: 'user', content: 'x'.repeat(900) },
      ];

      const result = callbacks.isAtBlockingLimit(messages, baseDeps.estimateTokens);

      assert.equal(result, false);
    });

    it('should use the injected estimateTokens function', () => {
      const customEstimator = (_msgs: QueryMessage[]) => 500;

      const callbacks = createQueryLoopParams({
        ...baseDeps,
        contextWindowTokens: 1000,
      });

      const messages: QueryMessage[] = [
        { uuid: 'u1', type: 'user', content: 'short' },
      ];

      // Custom estimator says 500 tokens, 95% of 1000 = 950, so not blocking
      const result = callbacks.isAtBlockingLimit(messages, customEstimator);
      assert.equal(result, false);
    });
  });

  describe('handleStopHooks callback', () => {
    it('should return no-op result (placeholder)', async () => {
      const callbacks = createQueryLoopParams(baseDeps);

      const result = await callbacks.handleStopHooks([], []);

      assert.equal(result.preventContinuation, false);
      assert.deepEqual(result.blockingErrors, []);
    });
  });
});
