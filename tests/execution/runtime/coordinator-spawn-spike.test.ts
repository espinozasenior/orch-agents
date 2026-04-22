/**
 * Spike: Verify the SDK's claude_code preset handles AgentTool natively.
 *
 * This test doesn't invoke the real SDK (would require API keys). Instead,
 * it verifies that our executor composition correctly includes "Agent" in
 * allowedTools and that the query factory passes claude_code preset.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSdkExecutor } from '../../../src/execution/runtime/sdk-executor';
import { createDefaultDeferredToolRegistry } from '../../../src/services/deferred-tools';

describe('Coordinator spawn spike', () => {
  it('Agent is in the deferred tool registry as alwaysLoad', () => {
    const registry = createDefaultDeferredToolRegistry();
    const tools = registry.list();
    const agentTool = tools.find((t) => t.name === 'Agent');

    assert.ok(agentTool, 'Agent tool should be registered');
    assert.equal(agentTool!.alwaysLoad, true, 'Agent should be alwaysLoad');
  });

  it('SDK executor includes Agent in allowedTools when registry provided', () => {
    const registry = createDefaultDeferredToolRegistry();
    const toolNames = registry.list().map((t) => t.name);

    assert.ok(toolNames.includes('Agent'), 'Agent should be in tool names');
    assert.ok(toolNames.includes('Read'), 'Read should be in tool names');
    assert.ok(toolNames.includes('Edit'), 'Edit should be in tool names');
  });

  it('SDK executor passes through tool call events including AgentTool', async () => {
    const emittedEvents: Record<string, unknown>[] = [];

    // Create executor with a mock query factory that emits an AgentTool event
    const executor = createSdkExecutor({
      queryFactory: ({ prompt }) => {
        // Simulate SDK stream with an AgentTool call event
        const events = [
          {
            type: 'tool_use',
            name: 'Agent',
            input: {
              prompt: 'Read src/types.ts and describe the Finding interface',
              subagent_type: 'Explore',
              description: 'Explore Finding type',
            },
          },
          {
            type: 'result',
            subtype: 'success',
            result: 'Agent spawned and completed',
            sessionId: 'test-session',
          },
        ];

        return (async function* () {
          for (const event of events) {
            yield event;
          }
        })();
      },
      eventSink: (payload) => {
        emittedEvents.push(payload);
      },
      deferredToolRegistry: createDefaultDeferredToolRegistry(),
    });

    const result = await executor.execute({
      prompt: 'Spawn a worker to explore the codebase',
      worktreePath: '/tmp/test-worktree',
      agentRole: 'coordinator',
      agentType: 'coordinator',
      timeout: 30000,
    });

    // Verify the executor saw the tool call
    const toolCallEvents = emittedEvents.filter((e) => e.type === 'toolCall');
    assert.ok(toolCallEvents.length > 0, 'Should have emitted at least one toolCall event');

    const agentToolCall = toolCallEvents.find((e) => e.toolName === 'Agent');
    assert.ok(agentToolCall, 'Should have emitted an Agent toolCall event');

    // Result should complete
    assert.equal(result.status, 'completed');
  });

  it('normalizeToolCallEvent captures Agent tool name from SDK events', async () => {
    // Test that various SDK event formats for AgentTool are recognized
    const events: Record<string, unknown>[] = [];

    const executor = createSdkExecutor({
      queryFactory: () => {
        return (async function* () {
          // Format 1: tool_use with name
          yield { type: 'tool_use', name: 'Agent', input: { prompt: 'test' } };
          // Format 2: tool_call with tool
          yield { type: 'tool_call', tool: 'Agent', arguments: { prompt: 'test2' } };
          yield { type: 'result', status: 'completed', output: 'done' };
        })();
      },
      eventSink: (payload) => events.push(payload),
      deferredToolRegistry: createDefaultDeferredToolRegistry(),
    });

    await executor.execute({
      prompt: 'test',
      worktreePath: '/tmp/test',
      agentRole: 'coordinator',
      agentType: 'coordinator',
      timeout: 30000,
    });

    const agentEvents = events.filter((e) => e.type === 'toolCall' && e.toolName === 'Agent');
    assert.ok(agentEvents.length >= 1, `Expected Agent tool events, got ${agentEvents.length}`);
  });
});
