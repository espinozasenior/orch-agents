/**
 * P12 — api-schema-filter tests (FR-P12-004).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DeferredToolRegistry, type DeferredToolDef } from '../../../src/services/deferred-tools/registry.js';
import { buildApiToolList } from '../../../src/services/deferred-tools/api-schema-filter.js';

const NOOP = async () => ({ content: '' });
const SCHEMA = { type: 'object', properties: { x: { type: 'string' } } };

function def(name: string, alwaysLoad = false, shouldDefer = true): DeferredToolDef {
  return {
    name,
    description: `${name} desc`,
    schema: SCHEMA,
    execute: NOOP,
    shouldDefer,
    alwaysLoad,
  };
}

describe('buildApiToolList', () => {
  it('alwaysLoad tools serialize with full input_schema and defer_loading=false', () => {
    const r = new DeferredToolRegistry();
    r.register(def('Read', true, false));
    const list = buildApiToolList(r);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, 'Read');
    assert.equal(list[0]!.input_schema, SCHEMA);
    assert.equal(list[0]!.defer_loading, false);
  });

  it('deferred tools serialize with input_schema=null and defer_loading=true', () => {
    const r = new DeferredToolRegistry();
    r.register(def('Foo', false, true));
    const list = buildApiToolList(r);
    assert.equal(list[0]!.input_schema, null);
    assert.equal(list[0]!.defer_loading, true);
  });

  it('preserves registration order', () => {
    const r = new DeferredToolRegistry();
    r.register(def('A', true, false));
    r.register(def('B', false, true));
    r.register(def('C', true, false));
    const names = buildApiToolList(r).map((t) => t.name);
    assert.deepEqual(names, ['A', 'B', 'C']);
  });

  it('is a pure function — does not mutate the registry', () => {
    const r = new DeferredToolRegistry();
    r.register(def('A', true, false));
    const before = r.list().length;
    buildApiToolList(r);
    buildApiToolList(r);
    assert.equal(r.list().length, before);
  });
});
