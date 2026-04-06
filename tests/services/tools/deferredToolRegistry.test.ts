/**
 * Phase 9G -- tests for DeferredToolRegistry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DeferredToolRegistry } from '../../../src/services/tools/deferredToolRegistry';
import type { DeferredToolDefinition } from '../../../src/services/tools/deferredTypes';

function eagerTool(name: string): DeferredToolDefinition {
  return {
    name,
    description: `${name} tool`,
    shouldDefer: false,
    concurrencySafe: true,
    interruptBehavior: 'cancel',
    persistResultToDisk: false,
    parameters: { type: 'object' },
    isConcurrencySafe: () => true,
    execute: async () => ({ content: 'ok' }),
  };
}

function deferredTool(name: string): DeferredToolDefinition {
  return {
    name,
    description: `${name} tool`,
    shouldDefer: true,
    concurrencySafe: false,
    interruptBehavior: 'wait',
    persistResultToDisk: true,
    parameters: { type: 'object', properties: { x: { type: 'number' } } },
    isConcurrencySafe: () => false,
    execute: async () => ({ content: 'deferred-ok' }),
  };
}

describe('DeferredToolRegistry', () => {
  it('register eager tool stores full schema immediately', () => {
    const reg = new DeferredToolRegistry();
    reg.register('Read', eagerTool('Read'));
    const resolved = reg.resolve('Read');
    assert.equal(resolved.name, 'Read');
    // Eager: parameters should exist
    assert.ok((resolved as DeferredToolDefinition).parameters);
  });

  it('register deferred tool strips parameters', () => {
    const reg = new DeferredToolRegistry();
    reg.register('BigTool', deferredTool('BigTool'));
    const def = reg.get('BigTool');
    assert.equal(def?.parameters, null);
  });

  it('resolve on deferred tool without provider marks resolved', () => {
    const reg = new DeferredToolRegistry();
    reg.register('X', deferredTool('X'));
    // Without schema provider, sync resolve just marks as resolved
    const resolved = reg.resolve('X');
    assert.equal(resolved.name, 'X');
    assert.ok((resolved as DeferredToolDefinition).resolvedAt);
  });

  it('resolveAsync fetches schema from provider', async () => {
    const provider = {
      fetchSchema: async (_name: string) => ({ type: 'object', properties: { y: { type: 'string' } } }),
    };
    const reg = new DeferredToolRegistry(provider);
    reg.register('Lazy', deferredTool('Lazy'));
    const resolved = await reg.resolveAsync('Lazy') as DeferredToolDefinition;
    assert.deepEqual(resolved.parameters, { type: 'object', properties: { y: { type: 'string' } } });
    assert.ok(resolved.resolvedAt);
  });

  it('resolveAsync returns cached schema on second call', async () => {
    let fetchCount = 0;
    const provider = {
      fetchSchema: async (_name: string) => {
        fetchCount++;
        return { type: 'object' };
      },
    };
    const reg = new DeferredToolRegistry(provider);
    reg.register('Cached', deferredTool('Cached'));
    await reg.resolveAsync('Cached');
    await reg.resolveAsync('Cached');
    assert.equal(fetchCount, 1);
  });

  it('resolveAsync deduplicates concurrent calls', async () => {
    let fetchCount = 0;
    const provider = {
      fetchSchema: async (_name: string) => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 10));
        return { type: 'object' };
      },
    };
    const reg = new DeferredToolRegistry(provider);
    reg.register('Dedup', deferredTool('Dedup'));
    const [a, b] = await Promise.all([
      reg.resolveAsync('Dedup'),
      reg.resolveAsync('Dedup'),
    ]);
    assert.equal(fetchCount, 1);
    assert.equal(a, b);
  });

  it('throws for unknown tool', () => {
    const reg = new DeferredToolRegistry();
    assert.throws(() => reg.resolve('nope'), { message: /Unknown tool/ });
  });

  it('resolveMany resolves multiple tools', () => {
    const reg = new DeferredToolRegistry();
    reg.register('A', eagerTool('A'));
    reg.register('B', eagerTool('B'));
    const results = reg.resolveMany(['A', 'B']);
    assert.equal(results.length, 2);
    assert.equal(results[0].name, 'A');
    assert.equal(results[1].name, 'B');
  });

  it('shouldDefer returns true for unresolved deferred tool', () => {
    const reg = new DeferredToolRegistry();
    reg.register('D', deferredTool('D'));
    assert.equal(reg.shouldDefer('D'), true);
  });

  it('shouldDefer returns false after resolution', () => {
    const reg = new DeferredToolRegistry();
    reg.register('D', deferredTool('D'));
    reg.resolve('D');
    assert.equal(reg.shouldDefer('D'), false);
  });

  it('listDeferred returns only unresolved tools', () => {
    const reg = new DeferredToolRegistry();
    reg.register('E', eagerTool('E'));
    reg.register('D1', deferredTool('D1'));
    reg.register('D2', deferredTool('D2'));
    reg.resolve('D1');
    const deferred = reg.listDeferred();
    assert.deepEqual(deferred, ['D2']);
  });

  it('getMetrics returns correct counts', () => {
    const reg = new DeferredToolRegistry();
    reg.register('E', eagerTool('E'));
    reg.register('D1', deferredTool('D1'));
    reg.register('D2', deferredTool('D2'));
    const metrics = reg.getMetrics();
    assert.equal(metrics.eagerCount, 1);
    assert.equal(metrics.deferredCount, 2);
    assert.equal(metrics.resolvedCount, 1); // eager counts as resolved
    assert.ok(metrics.memorySavedEstimate > 0);
  });
});
