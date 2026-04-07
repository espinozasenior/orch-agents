/**
 * P12 — ToolSearch tests (FR-P12-003, FR-P12-005).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { DeferredToolRegistry, type DeferredToolDef } from '../../../src/services/deferred-tools/registry.js';
import { ToolSearch } from '../../../src/services/deferred-tools/tool-search.js';

const NOOP = async () => ({ content: '' });
const SCHEMA = { type: 'object', properties: {} };

function def(name: string, description: string, opts: { alwaysLoad?: boolean } = {}): DeferredToolDef {
  return {
    name,
    description,
    schema: SCHEMA,
    execute: NOOP,
    shouldDefer: !opts.alwaysLoad,
    alwaysLoad: opts.alwaysLoad ?? false,
  };
}

let registry: DeferredToolRegistry;
let search: ToolSearch;

beforeEach(() => {
  registry = new DeferredToolRegistry();
  registry.register(def('browser_screenshot', 'Capture a screenshot of the page'));
  registry.register(def('browser_click', 'Click an element on the page'));
  registry.register(def('image_compress', 'Compress images on disk'));
  registry.register(def('mcp__cf__memory_store', 'Store memory in claude-flow'));
  registry.register(def('mcp__cf__memory_search', 'Search memory in claude-flow'));
  registry.register(def('mcp__other__thing', 'A different mcp tool'));
  search = new ToolSearch(registry);
});

describe('ToolSearch — select form', () => {
  it('returns the named tool', () => {
    const r = search.search({ query: 'select:browser_click' });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]!.name, 'browser_click');
    assert.equal(r.matches[0]!.description, 'Click an element on the page');
  });

  it('supports comma-separated multi-select', () => {
    const r = search.search({ query: 'select:browser_click,browser_screenshot' });
    assert.equal(r.matches.length, 2);
    assert.deepEqual(r.matches.map((m) => m.name).sort(), ['browser_click', 'browser_screenshot']);
  });

  it('skips unknown names silently', () => {
    const r = search.search({ query: 'select:browser_click,does_not_exist' });
    assert.equal(r.matches.length, 1);
  });

  it('total_deferred_tools reflects registry deferred count', () => {
    const r = search.search({ query: 'select:browser_click' });
    assert.equal(r.total_deferred_tools, 6);
  });
});

describe('ToolSearch — keyword form', () => {
  it('ranks name matches above description matches', () => {
    const r = search.search({ query: 'screenshot' });
    assert.ok(r.matches.length > 0);
    assert.equal(r.matches[0]!.name, 'browser_screenshot');
  });

  it('+required filters by name substring', () => {
    const r = search.search({ query: '+browser image' });
    // Only browser_* tools should appear
    for (const m of r.matches) {
      assert.ok(m.name.includes('browser'), `unexpected: ${m.name}`);
    }
  });

  it('mcp__server__ prefix filters to that server', () => {
    const r = search.search({ query: 'mcp__cf__ memory' });
    assert.ok(r.matches.length > 0);
    for (const m of r.matches) {
      assert.ok(m.name.startsWith('mcp__cf__'), `unexpected: ${m.name}`);
    }
  });

  it('respects max_results', () => {
    const r = search.search({ query: 'browser', max_results: 1 });
    assert.equal(r.matches.length, 1);
  });
});

describe('ToolSearch — description cache (FR-P12-005)', () => {
  it('hits cache on second describe of the same name', () => {
    const s = new ToolSearch(registry);
    s.describe('browser_click');
    s.describe('browser_click');
    s.describe('browser_click');
    const stats = s.getCacheStats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.hits, 2);
    assert.equal(stats.size, 1);
  });

  it('returns undefined for unknown tools without polluting the cache', () => {
    const s = new ToolSearch(registry);
    assert.equal(s.describe('nope'), undefined);
    assert.equal(s.getCacheStats().size, 0);
  });
});
