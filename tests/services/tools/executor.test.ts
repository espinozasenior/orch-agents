import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runTools,
  runToolsConcurrently,
  runToolsSerially,
} from '../../../src/services/tools/executor.js';
import type {
  Batch,
  ToolDefinition,
  ToolUseBlock,
} from '../../../src/services/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function block(id: string, name: string): ToolUseBlock {
  return { id, name, input: {} };
}

function delayTool(name: string, ms: number, safe: boolean): ToolDefinition {
  return {
    name,
    isConcurrencySafe: () => safe,
    execute: async () => {
      await new Promise((r) => setTimeout(r, ms));
      return { content: `${name}-done` };
    },
  };
}

function failingTool(name: string): ToolDefinition {
  return {
    name,
    isConcurrencySafe: () => true,
    execute: async () => { throw new Error('boom'); },
  };
}

function toolMap(...defs: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(defs.map((d) => [d.name, d]));
}

// ---------------------------------------------------------------------------
// runToolsConcurrently
// ---------------------------------------------------------------------------

describe('runToolsConcurrently', () => {
  it('runs faster than serial for concurrent-safe batch', async () => {
    const delay = 50;
    const count = 5;
    const tool = delayTool('Read', delay, true);
    const tools = toolMap(tool);
    const batch: Batch = {
      isConcurrencySafe: true,
      blocks: Array.from({ length: count }, (_, i) => block(String(i), 'Read')),
    };

    const start = Date.now();
    const results = await runToolsConcurrently(batch, tools);
    const elapsed = Date.now() - start;

    assert.equal(results.length, count);
    // Serial would take count * delay = 250ms; concurrent should be ~50ms
    assert.ok(elapsed < delay * count - delay, `Expected < ${delay * count - delay}ms, got ${elapsed}ms`);
  });

  it('respects max concurrency limit', async () => {
    let peak = 0;
    let running = 0;

    const tool: ToolDefinition = {
      name: 'Slow',
      isConcurrencySafe: () => true,
      execute: async () => {
        running++;
        if (running > peak) peak = running;
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return { content: 'ok' };
      },
    };

    const tools = toolMap(tool);
    const batch: Batch = {
      isConcurrencySafe: true,
      blocks: Array.from({ length: 8 }, (_, i) => block(String(i), 'Slow')),
    };

    await runToolsConcurrently(batch, tools, 3);

    assert.ok(peak <= 3, `Peak concurrency was ${peak}, expected <= 3`);
  });

  it('handles tool execution errors without crashing the batch', async () => {
    const good = delayTool('Read', 5, true);
    const bad = failingTool('BadTool');
    const tools = toolMap(good, bad);

    const batch: Batch = {
      isConcurrencySafe: true,
      blocks: [block('1', 'Read'), block('2', 'BadTool'), block('3', 'Read')],
    };

    const results = await runToolsConcurrently(batch, tools);

    assert.equal(results.length, 3);
    assert.equal(results[0].result?.is_error, undefined);
    assert.equal(results[1].result?.is_error, true);
    assert.equal(results[1].error, 'boom');
    assert.equal(results[2].result?.is_error, undefined);
  });
});

// ---------------------------------------------------------------------------
// runToolsSerially
// ---------------------------------------------------------------------------

describe('runToolsSerially', () => {
  it('maintains execution order', async () => {
    const order: string[] = [];
    function orderedTool(name: string): ToolDefinition {
      return {
        name,
        isConcurrencySafe: () => false,
        execute: async () => {
          order.push(name);
          return { content: name };
        },
      };
    }

    const tools = toolMap(orderedTool('A'), orderedTool('B'), orderedTool('C'));
    const batch: Batch = {
      isConcurrencySafe: false,
      blocks: [block('1', 'A'), block('2', 'B'), block('3', 'C')],
    };

    await runToolsSerially(batch, tools);

    assert.deepEqual(order, ['A', 'B', 'C']);
  });
});

// ---------------------------------------------------------------------------
// runTools (orchestrator)
// ---------------------------------------------------------------------------

describe('runTools', () => {
  it('partitions and dispatches mixed tool calls', async () => {
    const readTool = delayTool('Read', 5, true);
    const writeTool = delayTool('Edit', 5, false);
    const tools = toolMap(readTool, writeTool);

    const blocks = [
      block('1', 'Read'),
      block('2', 'Read'),
      block('3', 'Edit'),
      block('4', 'Read'),
    ];

    const results = await runTools(blocks, tools);

    assert.equal(results.length, 4);
    assert.equal(results[0].toolUseId, '1');
    // All results should have content (order within concurrent batch may vary)
    for (const r of results) {
      assert.ok(r.result);
      assert.ok(r.result.content.length > 0);
    }
  });

  it('returns error update for unknown tools', async () => {
    const blocks = [block('1', 'UnknownTool')];
    const tools = toolMap();

    const results = await runTools(blocks, tools);

    assert.equal(results.length, 1);
    assert.equal(results[0].result?.is_error, true);
    assert.ok(results[0].error?.includes('Unknown tool'));
  });

  it('concurrent batch of 5 completes in ~1x single call time', async () => {
    const tool = delayTool('Glob', 50, true);
    const tools = toolMap(tool);
    const blocks = Array.from({ length: 5 }, (_, i) => block(String(i), 'Glob'));

    const start = Date.now();
    await runTools(blocks, tools);
    const elapsed = Date.now() - start;

    // 5 x 50ms serial = 250ms; concurrent should be under 150ms
    assert.ok(elapsed < 150, `Expected < 150ms, got ${elapsed}ms`);
  });
});
