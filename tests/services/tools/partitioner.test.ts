import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { partitionToolCalls } from '../../../src/services/tools/partitioner.js';
import type { ToolDefinition, ToolUseBlock } from '../../../src/services/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function block(id: string, name: string): ToolUseBlock {
  return { id, name, input: {} };
}

function safeTool(name: string): ToolDefinition {
  return {
    name,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: 'ok' }),
  };
}

function unsafeTool(name: string): ToolDefinition {
  return {
    name,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: 'ok' }),
  };
}

function throwingTool(name: string): ToolDefinition {
  return {
    name,
    isConcurrencySafe: () => { throw new Error('classifier error'); },
    execute: async () => ({ content: 'ok' }),
  };
}

function toolMap(...defs: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(defs.map((d) => [d.name, d]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('partitionToolCalls', () => {
  it('groups consecutive read-only tools into one concurrent batch', () => {
    const blocks = [block('1', 'Glob'), block('2', 'Grep'), block('3', 'Read')];
    const tools = toolMap(safeTool('Glob'), safeTool('Grep'), safeTool('Read'));

    const batches = partitionToolCalls(blocks, tools);

    assert.equal(batches.length, 1);
    assert.equal(batches[0].isConcurrencySafe, true);
    assert.equal(batches[0].blocks.length, 3);
  });

  it('isolates write tools into individual serial batches', () => {
    const blocks = [block('1', 'Edit'), block('2', 'Write')];
    const tools = toolMap(unsafeTool('Edit'), unsafeTool('Write'));

    const batches = partitionToolCalls(blocks, tools);

    assert.equal(batches.length, 2);
    assert.equal(batches[0].isConcurrencySafe, false);
    assert.equal(batches[0].blocks.length, 1);
    assert.equal(batches[1].isConcurrencySafe, false);
    assert.equal(batches[1].blocks.length, 1);
  });

  it('handles mixed read/write sequences correctly', () => {
    const blocks = [
      block('1', 'Glob'),
      block('2', 'Edit'),
      block('3', 'Read'),
    ];
    const tools = toolMap(safeTool('Glob'), unsafeTool('Edit'), safeTool('Read'));

    const batches = partitionToolCalls(blocks, tools);

    assert.equal(batches.length, 3);
    assert.equal(batches[0].isConcurrencySafe, true);
    assert.equal(batches[0].blocks[0].name, 'Glob');
    assert.equal(batches[1].isConcurrencySafe, false);
    assert.equal(batches[1].blocks[0].name, 'Edit');
    assert.equal(batches[2].isConcurrencySafe, true);
    assert.equal(batches[2].blocks[0].name, 'Read');
  });

  it('treats unknown tools as unsafe', () => {
    const blocks = [block('1', 'custom_mcp_tool')];
    const tools = toolMap(); // empty

    const batches = partitionToolCalls(blocks, tools);

    assert.equal(batches.length, 1);
    assert.equal(batches[0].isConcurrencySafe, false);
  });

  it('treats isConcurrencySafe errors as unsafe', () => {
    const blocks = [block('1', 'Broken')];
    const tools = toolMap(throwingTool('Broken'));

    const batches = partitionToolCalls(blocks, tools);

    assert.equal(batches.length, 1);
    assert.equal(batches[0].isConcurrencySafe, false);
  });

  it('returns empty array for empty input', () => {
    const batches = partitionToolCalls([], toolMap());
    assert.equal(batches.length, 0);
  });

  it('groups multiple consecutive safe blocks after an unsafe block', () => {
    const blocks = [
      block('1', 'Edit'),
      block('2', 'Glob'),
      block('3', 'Grep'),
      block('4', 'Read'),
    ];
    const tools = toolMap(
      unsafeTool('Edit'),
      safeTool('Glob'),
      safeTool('Grep'),
      safeTool('Read'),
    );

    const batches = partitionToolCalls(blocks, tools);

    assert.equal(batches.length, 2);
    assert.equal(batches[0].isConcurrencySafe, false);
    assert.equal(batches[0].blocks.length, 1);
    assert.equal(batches[1].isConcurrencySafe, true);
    assert.equal(batches[1].blocks.length, 3);
  });
});
