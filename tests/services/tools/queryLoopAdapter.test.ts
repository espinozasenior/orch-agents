import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutionCallback } from '../../../src/services/tools/queryLoopAdapter.js';
import { createToolRegistry } from '../../../src/services/tools/toolDefinitions.js';

describe('queryLoopAdapter', () => {
  describe('createToolExecutionCallback', () => {
    it('returns empty messages for empty tool blocks', async () => {
      const delegate = mock.fn(async () => ({ content: 'ok' }));
      const registry = createToolRegistry(delegate);
      const callback = createToolExecutionCallback(registry);

      const result = await callback([]);
      assert.deepEqual(result, { messages: [] });
      assert.equal(delegate.mock.callCount(), 0);
    });

    it('converts tool blocks to P4 format and returns messages', async () => {
      const delegate = mock.fn(async (_name: string, _input: Record<string, unknown>) => ({
        content: 'file contents here',
      }));
      const registry = createToolRegistry(delegate);
      const callback = createToolExecutionCallback(registry);

      const result = await callback([
        { id: 'tool-1', name: 'Read', input: { path: '/foo.ts' } },
      ]);

      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].uuid, 'tool-1');
      assert.equal(result.messages[0].type, 'system');
      assert.equal(result.messages[0].content, 'file contents here');
    });

    it('handles multiple tool blocks', async () => {
      const delegate = mock.fn(async (name: string) => ({
        content: `result-${name}`,
      }));
      const registry = createToolRegistry(delegate);
      const callback = createToolExecutionCallback(registry);

      const result = await callback([
        { id: 'tool-1', name: 'Read', input: { path: '/a.ts' } },
        { id: 'tool-2', name: 'Glob', input: { pattern: '*.ts' } },
        { id: 'tool-3', name: 'Grep', input: { pattern: 'TODO' } },
      ]);

      assert.equal(result.messages.length, 3);
      assert.equal(result.messages[0].content, 'result-Read');
      assert.equal(result.messages[1].content, 'result-Glob');
      assert.equal(result.messages[2].content, 'result-Grep');
    });

    it('handles tool execution errors gracefully', async () => {
      const delegate = mock.fn(async (name: string) => {
        if (name === 'Bash') {
          throw new Error('command failed');
        }
        return { content: 'ok' };
      });
      const registry = createToolRegistry(delegate);
      const callback = createToolExecutionCallback(registry);

      const result = await callback([
        { id: 'tool-1', name: 'Bash', input: { command: 'exit 1' } },
      ]);

      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].uuid, 'tool-1');
      assert.ok(result.messages[0].content.includes('command failed'));
    });

    it('handles unknown tools', async () => {
      const delegate = mock.fn(async () => ({ content: 'ok' }));
      const registry = createToolRegistry(delegate);
      const callback = createToolExecutionCallback(registry);

      const result = await callback([
        { id: 'tool-1', name: 'UnknownTool', input: {} },
      ]);

      assert.equal(result.messages.length, 1);
      assert.ok(result.messages[0].content.includes('Unknown tool'));
    });

    it('respects maxConcurrency parameter', async () => {
      let concurrentCount = 0;
      let maxConcurrentSeen = 0;

      const delegate = mock.fn(async () => {
        concurrentCount++;
        maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrentCount);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentCount--;
        return { content: 'ok' };
      });
      const registry = createToolRegistry(delegate);
      const callback = createToolExecutionCallback(registry, 2);

      // All read-only tools — they will be batched concurrently
      const blocks = Array.from({ length: 4 }, (_, i) => ({
        id: `tool-${i}`,
        name: 'Glob',
        input: { pattern: `*.${i}` },
      }));

      const result = await callback(blocks);
      assert.equal(result.messages.length, 4);
      assert.ok(maxConcurrentSeen <= 2, `max concurrent was ${maxConcurrentSeen}, expected <= 2`);
    });

    it('preserves tool use ID as message uuid', async () => {
      const delegate = mock.fn(async () => ({ content: 'ok' }));
      const registry = createToolRegistry(delegate);
      const callback = createToolExecutionCallback(registry);

      const result = await callback([
        { id: 'unique-tool-id-abc', name: 'Read', input: {} },
      ]);

      assert.equal(result.messages[0].uuid, 'unique-tool-id-abc');
    });

    it('uses error string when result is missing', async () => {
      const delegate = mock.fn(async () => {
        throw new Error('delegate error');
      });
      const registry = createToolRegistry(delegate);
      const callback = createToolExecutionCallback(registry);

      const result = await callback([
        { id: 'tool-1', name: 'Read', input: {} },
      ]);

      assert.equal(result.messages[0].content, 'delegate error');
    });
  });
});
