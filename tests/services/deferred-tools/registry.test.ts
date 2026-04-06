/**
 * P12 — DeferredToolRegistry tests (FR-P12-001, FR-P12-006).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DeferredToolRegistry,
  DuplicateToolError,
  type DeferredToolDef,
} from '../../../src/services/deferred-tools/registry.js';

const NOOP = async () => ({ content: '' });
const SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

function makeDef(overrides: Partial<DeferredToolDef> = {}): DeferredToolDef {
  return {
    name: 'Foo',
    description: 'a foo tool',
    schema: SCHEMA,
    execute: NOOP,
    shouldDefer: true,
    alwaysLoad: false,
    isConcurrencySafe: () => true,
    ...overrides,
  };
}

describe('DeferredToolRegistry — registration', () => {
  it('stores the full ToolDef on register', () => {
    const r = new DeferredToolRegistry();
    r.register(makeDef());
    const got = r.get('Foo');
    assert.ok(got);
    assert.equal(got!.name, 'Foo');
    assert.equal(got!.description, 'a foo tool');
    assert.equal(got!.schema, SCHEMA);
  });

  it('throws DuplicateToolError on re-registration', () => {
    const r = new DeferredToolRegistry();
    r.register(makeDef());
    assert.throws(() => r.register(makeDef()), DuplicateToolError);
  });

  it('list() preserves registration order', () => {
    const r = new DeferredToolRegistry();
    r.register(makeDef({ name: 'A' }));
    r.register(makeDef({ name: 'B' }));
    r.register(makeDef({ name: 'C' }));
    assert.deepEqual(r.list().map((t) => t.name), ['A', 'B', 'C']);
  });
});

describe('DeferredToolRegistry — filtering', () => {
  it('listDeferred excludes alwaysLoad tools', () => {
    const r = new DeferredToolRegistry();
    r.register(makeDef({ name: 'D1', shouldDefer: true, alwaysLoad: false }));
    r.register(makeDef({ name: 'A1', shouldDefer: false, alwaysLoad: true }));
    r.register(makeDef({ name: 'D2', shouldDefer: true, alwaysLoad: false }));
    assert.deepEqual(r.listDeferred().map((t) => t.name), ['D1', 'D2']);
  });

  it('listAlwaysLoad returns only alwaysLoad=true', () => {
    const r = new DeferredToolRegistry();
    r.register(makeDef({ name: 'D1', shouldDefer: true, alwaysLoad: false }));
    r.register(makeDef({ name: 'A1', shouldDefer: false, alwaysLoad: true }));
    assert.deepEqual(r.listAlwaysLoad().map((t) => t.name), ['A1']);
  });
});

describe('DeferredToolRegistry — toP4Registry (FR-P12-006)', () => {
  it('produces a P4-shaped Map', () => {
    const r = new DeferredToolRegistry();
    r.register(makeDef({ name: 'Read', isConcurrencySafe: () => true }));
    r.register(makeDef({ name: 'Edit', isConcurrencySafe: () => false }));
    const map = r.toP4Registry();
    assert.equal(map.size, 2);
    assert.equal(map.get('Read')!.isConcurrencySafe({}), true);
    assert.equal(map.get('Edit')!.isConcurrencySafe({}), false);
  });

  it('defaults isConcurrencySafe to false when unspecified', () => {
    const r = new DeferredToolRegistry();
    const def: DeferredToolDef = {
      name: 'X',
      description: 'x',
      schema: SCHEMA,
      execute: NOOP,
      shouldDefer: true,
      alwaysLoad: false,
    };
    r.register(def);
    const p4 = r.toP4Registry().get('X')!;
    assert.equal(p4.isConcurrencySafe({}), false);
  });
});
