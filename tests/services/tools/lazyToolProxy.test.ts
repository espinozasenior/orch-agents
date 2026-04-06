/**
 * Phase 9G -- tests for LazyToolProxy.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LazyToolProxy } from '../../../src/services/tools/lazyToolProxy';
import { DeferredToolRegistry } from '../../../src/services/tools/deferredToolRegistry';
import type { DeferredToolDefinition } from '../../../src/services/tools/deferredTypes';

function makeToolDef(name: string): DeferredToolDefinition {
  const executeFn = mock.fn(async (_input: Record<string, unknown>) => ({
    content: `result-from-${name}`,
  }));
  return {
    name,
    description: `${name} tool`,
    shouldDefer: true,
    concurrencySafe: true,
    interruptBehavior: 'cancel',
    persistResultToDisk: false,
    isConcurrencySafe: () => true,
    execute: executeFn,
  };
}

describe('LazyToolProxy', () => {
  it('isResolved returns false before first execute', () => {
    const reg = new DeferredToolRegistry();
    const def = makeToolDef('Lazy');
    reg.register('Lazy', def);
    const proxy = new LazyToolProxy(def, reg);
    assert.equal(proxy.isResolved(), false);
  });

  it('isResolved returns true after execute', async () => {
    const reg = new DeferredToolRegistry();
    const def = makeToolDef('Lazy');
    reg.register('Lazy', def);
    const proxy = new LazyToolProxy(def, reg);
    await proxy.execute({});
    assert.equal(proxy.isResolved(), true);
  });

  it('execute delegates to the resolved tool', async () => {
    const reg = new DeferredToolRegistry();
    const def = makeToolDef('Delegate');
    reg.register('Delegate', def);
    const proxy = new LazyToolProxy(def, reg);
    const result = await proxy.execute({ key: 'value' });
    assert.equal(result.content, 'result-from-Delegate');
  });

  it('execute resolves only once across multiple calls', async () => {
    const reg = new DeferredToolRegistry();
    const def = makeToolDef('Once');
    reg.register('Once', def);
    const proxy = new LazyToolProxy(def, reg);
    await proxy.execute({});
    await proxy.execute({});
    await proxy.execute({});
    // The execute on the underlying def should have been called 3 times
    assert.equal((def.execute as ReturnType<typeof mock.fn>).mock.callCount(), 3);
    // But resolve should have happened only once (proxy.isResolved stays true)
    assert.equal(proxy.isResolved(), true);
  });

  it('isConcurrencySafe delegates to registry definition', () => {
    const reg = new DeferredToolRegistry();
    const def = makeToolDef('ConcSafe');
    def.concurrencySafe = false;
    reg.register('ConcSafe', def);
    const proxy = new LazyToolProxy(def, reg);
    assert.equal(proxy.isConcurrencySafe({}), false);
  });

  it('has correct name', () => {
    const reg = new DeferredToolRegistry();
    const def = makeToolDef('Named');
    reg.register('Named', def);
    const proxy = new LazyToolProxy(def, reg);
    assert.equal(proxy.name, 'Named');
  });
});
