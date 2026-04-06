/**
 * P12 — prompt-builder tests (FR-P12-002, FR-P12-007 partial).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DeferredToolRegistry, type DeferredToolDef } from '../../../src/services/deferred-tools/registry.js';
import {
  buildPromptAdvertisement,
  PROMPT_BUDGET_BYTES,
} from '../../../src/services/deferred-tools/prompt-builder.js';

const NOOP = async () => ({ content: '' });
const SCHEMA = { type: 'object', properties: { x: { type: 'string' } } };

function def(name: string, description: string, alwaysLoad = false): DeferredToolDef {
  return {
    name,
    description,
    schema: SCHEMA,
    execute: NOOP,
    shouldDefer: !alwaysLoad,
    alwaysLoad,
  };
}

describe('buildPromptAdvertisement', () => {
  it('renders alwaysLoad tools with full schema inline', () => {
    const r = new DeferredToolRegistry();
    r.register(def('Read', 'Read a file', true));
    const out = buildPromptAdvertisement(r);
    assert.match(out, /### Read/);
    assert.match(out, /Read a file/);
    assert.match(out, /```json/);
    assert.match(out, /"properties"/);
  });

  it('renders deferred tools as one-line summaries', () => {
    const r = new DeferredToolRegistry();
    r.register(def('foo', 'does foo'));
    const out = buildPromptAdvertisement(r);
    assert.match(out, /- foo: does foo/);
  });

  it('omits the "Deferred Tools" header when none are deferred', () => {
    const r = new DeferredToolRegistry();
    r.register(def('Read', 'Read a file', true));
    const out = buildPromptAdvertisement(r);
    assert.doesNotMatch(out, /Deferred Tools/);
  });

  it('always-load section appears before deferred section', () => {
    const r = new DeferredToolRegistry();
    r.register(def('Read', 'Read a file', true));
    r.register(def('foo', 'does foo'));
    const out = buildPromptAdvertisement(r);
    assert.ok(out.indexOf('### Read') < out.indexOf('- foo:'));
  });

  it('truncates and emits the "+ N more" tail when over budget', () => {
    const r = new DeferredToolRegistry();
    for (let i = 0; i < 100; i++) {
      r.register(def(`tool_${i}`, 'x'.repeat(50)));
    }
    const tinyBudget = 512;
    const out = buildPromptAdvertisement(r, tinyBudget);
    assert.match(out, /\+ \d+ more tools available via ToolSearch/);
    assert.ok(Buffer.byteLength(out, 'utf8') < tinyBudget + 200);
  });
});
