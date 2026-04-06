/**
 * P12 — FR-P12-007 prompt budget eval.
 *
 * Registers N synthetic deferred tools and asserts the prompt
 * advertisement stays under the 8 KB budget for every N.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DeferredToolRegistry, type DeferredToolDef } from '../../src/services/deferred-tools/registry.js';
import {
  buildPromptAdvertisement,
  PROMPT_BUDGET_BYTES,
} from '../../src/services/deferred-tools/prompt-builder.js';
import { createDefaultDeferredToolRegistry } from '../../src/services/deferred-tools/bootstrap.js';

const NOOP = async () => ({ content: '' });
const SCHEMA = { type: 'object', properties: {} };

function makeRegistry(n: number): DeferredToolRegistry {
  // Start from the default (alwaysLoad core + ToolSearch) so we exercise
  // the realistic budget scenario.
  const r = createDefaultDeferredToolRegistry();
  for (let i = 0; i < n; i++) {
    const def: DeferredToolDef = {
      name: `synthetic_tool_${i.toString().padStart(4, '0')}`,
      description: `Synthetic deferred tool number ${i} used for the prompt-budget eval.`,
      schema: SCHEMA,
      execute: NOOP,
      shouldDefer: true,
      alwaysLoad: false,
    };
    r.register(def);
  }
  return r;
}

describe('FR-P12-007 — prompt budget eval', () => {
  for (const n of [10, 50, 100, 500]) {
    it(`stays under ${PROMPT_BUDGET_BYTES} bytes at N=${n}`, () => {
      const r = makeRegistry(n);
      const out = buildPromptAdvertisement(r);
      const bytes = Buffer.byteLength(out, 'utf8');
      assert.ok(
        bytes <= PROMPT_BUDGET_BYTES,
        `N=${n}: prompt ${bytes} bytes exceeds ${PROMPT_BUDGET_BYTES}`,
      );
    });
  }

  it('always includes the ToolSearch always-load schema', () => {
    const r = makeRegistry(500);
    const out = buildPromptAdvertisement(r);
    assert.match(out, /### ToolSearch/);
  });

  it('emits the "+ N more" tail when N is large', () => {
    const r = makeRegistry(500);
    const out = buildPromptAdvertisement(r);
    // 500 deferred tools at ~80 bytes each = ~40 KB raw → must truncate
    assert.match(out, /\+ \d+ more tools available via ToolSearch/);
  });
});
