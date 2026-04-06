import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolRegistry,
  createDefaultToolRegistry,
  registerTool,
} from '../../../src/services/tools/toolDefinitions.js';
import {
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
} from '../../../src/services/tools/concurrencyClassifier.js';

describe('toolDefinitions', () => {
  describe('createToolRegistry', () => {
    it('creates entries for all known tools', () => {
      const delegate = mock.fn(async () => ({ content: 'ok' }));
      const registry = createToolRegistry(delegate);

      const expectedCount = READ_ONLY_TOOLS.size + WRITE_TOOLS.size;
      assert.equal(registry.size, expectedCount);
    });

    it('marks read-only tools as concurrency-safe', () => {
      const delegate = mock.fn(async () => ({ content: 'ok' }));
      const registry = createToolRegistry(delegate);

      for (const name of READ_ONLY_TOOLS) {
        const tool = registry.get(name);
        assert.ok(tool, `Missing tool: ${name}`);
        assert.equal(tool.isConcurrencySafe({}), true, `${name} should be safe`);
      }
    });

    it('marks write tools as not concurrency-safe', () => {
      const delegate = mock.fn(async () => ({ content: 'ok' }));
      const registry = createToolRegistry(delegate);

      for (const name of WRITE_TOOLS) {
        const tool = registry.get(name);
        assert.ok(tool, `Missing tool: ${name}`);
        assert.equal(tool.isConcurrencySafe({}), false, `${name} should be unsafe`);
      }
    });

    it('delegates execute to the provided delegate', async () => {
      const delegate = mock.fn(async (_name: string, _input: Record<string, unknown>) => ({
        content: 'result-from-delegate',
      }));
      const registry = createToolRegistry(delegate);

      const readTool = registry.get('Read');
      assert.ok(readTool);

      const result = await readTool.execute({ path: '/foo.ts' });
      assert.equal(result.content, 'result-from-delegate');
      assert.equal(delegate.mock.callCount(), 1);

      const call = delegate.mock.calls[0];
      assert.equal(call.arguments[0], 'Read');
      assert.deepEqual(call.arguments[1], { path: '/foo.ts' });
    });

    it('each tool name matches its definition name', () => {
      const delegate = mock.fn(async () => ({ content: 'ok' }));
      const registry = createToolRegistry(delegate);

      for (const [key, tool] of registry) {
        assert.equal(key, tool.name, `Key "${key}" should match tool.name "${tool.name}"`);
      }
    });
  });

  describe('createDefaultToolRegistry', () => {
    it('returns a registry with error-returning execute', async () => {
      const registry = createDefaultToolRegistry();

      const tool = registry.get('Read');
      assert.ok(tool);

      const result = await tool.execute({});
      assert.equal(result.is_error, true);
      assert.ok(result.content.includes('No delegate configured'));
    });

    it('has same size as createToolRegistry', () => {
      const delegate = mock.fn(async () => ({ content: 'ok' }));
      const withDelegate = createToolRegistry(delegate);
      const defaultReg = createDefaultToolRegistry();

      assert.equal(defaultReg.size, withDelegate.size);
    });
  });

  describe('registerTool', () => {
    it('adds a new tool to the registry', () => {
      const delegate = mock.fn(async () => ({ content: 'ok' }));
      const registry = createToolRegistry(delegate);
      const sizeBefore = registry.size;

      const mcpDelegate = mock.fn(async () => ({ content: 'mcp-result' }));
      registerTool(registry, 'mcp__custom_tool', false, mcpDelegate);

      assert.equal(registry.size, sizeBefore + 1);

      const tool = registry.get('mcp__custom_tool');
      assert.ok(tool);
      assert.equal(tool.name, 'mcp__custom_tool');
      assert.equal(tool.isConcurrencySafe({}), false);
    });

    it('can add a concurrency-safe tool', async () => {
      const delegate = mock.fn(async () => ({ content: 'ok' }));
      const registry = createToolRegistry(delegate);

      const safeDelegate = mock.fn(async () => ({ content: 'safe-result' }));
      registerTool(registry, 'mcp__safe_read', true, safeDelegate);

      const tool = registry.get('mcp__safe_read');
      assert.ok(tool);
      assert.equal(tool.isConcurrencySafe({}), true);

      const result = await tool.execute({ query: 'test' });
      assert.equal(result.content, 'safe-result');
    });

    it('overrides existing tool definition', () => {
      const delegate = mock.fn(async () => ({ content: 'original' }));
      const registry = createToolRegistry(delegate);

      const override = mock.fn(async () => ({ content: 'override' }));
      registerTool(registry, 'Read', false, override);

      const tool = registry.get('Read');
      assert.ok(tool);
      // Now overridden to unsafe
      assert.equal(tool.isConcurrencySafe({}), false);
    });
  });
});
