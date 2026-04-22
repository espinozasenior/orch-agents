/**
 * Tests for DirectSpawnToolDef — the deferred tool definition that
 * wraps DirectSpawnStrategy for the Agent tool.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createDirectSpawnToolDef } from '../../../src/execution/runtime/direct-spawn-tool';
import type { DirectSpawnStrategy } from '../../../src/execution/runtime/direct-spawn-strategy';

function createMockStrategy(executeResult = 'mock output'): DirectSpawnStrategy {
  return {
    executeAgentTool: mock.fn(async () => executeResult),
    getChildStatus: mock.fn(() => undefined),
    cancelChild: mock.fn(),
    getActiveChildren: mock.fn(() => []),
  };
}

describe('createDirectSpawnToolDef', () => {
  it('returns a DeferredToolDef named "Agent"', () => {
    const strategy = createMockStrategy();
    const toolDef = createDirectSpawnToolDef(strategy);

    assert.equal(toolDef.name, 'Agent');
    assert.equal(toolDef.shouldDefer, false);
    assert.equal(toolDef.alwaysLoad, true);
  });

  it('has a valid JSON schema with required "prompt" field', () => {
    const strategy = createMockStrategy();
    const toolDef = createDirectSpawnToolDef(strategy);

    const schema = toolDef.schema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };

    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.prompt, 'schema has prompt property');
    assert.ok(schema.properties.subagent_type, 'schema has subagent_type property');
    assert.ok(schema.properties.description, 'schema has description property');
    assert.ok(schema.properties.isolation, 'schema has isolation property');
    assert.deepEqual(schema.required, ['prompt']);
  });

  it('execute() routes to strategy.executeAgentTool', async () => {
    const strategy = createMockStrategy('child result');
    const toolDef = createDirectSpawnToolDef(strategy);

    const result = await toolDef.execute({
      prompt: 'Do something',
      subagent_type: 'coder',
    });

    assert.deepEqual(result, { content: 'child result', is_error: false });
    assert.equal(
      (strategy.executeAgentTool as ReturnType<typeof mock.fn>).mock.callCount(),
      1,
    );

    const call = (strategy.executeAgentTool as ReturnType<typeof mock.fn>).mock.calls[0];
    assert.equal(call.arguments[0].prompt, 'Do something');
    assert.equal(call.arguments[0].subagent_type, 'coder');
  });

  it('execute() handles empty/missing prompt gracefully', async () => {
    const strategy = createMockStrategy('ok');
    const toolDef = createDirectSpawnToolDef(strategy);

    const result = await toolDef.execute({});

    assert.deepEqual(result, { content: 'ok', is_error: false });
    const call = (strategy.executeAgentTool as ReturnType<typeof mock.fn>).mock.calls[0];
    assert.equal(call.arguments[0].prompt, '');
  });

  it('isConcurrencySafe returns false (spawns child processes)', () => {
    const strategy = createMockStrategy();
    const toolDef = createDirectSpawnToolDef(strategy);

    assert.equal(toolDef.isConcurrencySafe!({} as Record<string, unknown>), false);
  });

  it('description indicates direct mode', () => {
    const strategy = createMockStrategy();
    const toolDef = createDirectSpawnToolDef(strategy);

    assert.ok(toolDef.description.includes('direct mode'));
  });
});
