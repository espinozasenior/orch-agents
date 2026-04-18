/**
 * Setup module tests.
 *
 * Tests the workflow-editor and renderer utilities.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// H2: multiSelect must NOT mutate caller's items
// ---------------------------------------------------------------------------

describe('multiSelect item isolation', () => {
  it('does not mutate the original items array', async () => {
    const { multiSelect } = await import('../../src/setup/renderer');
    const items = [
      { value: 'a', label: 'A', selected: false },
      { value: 'b', label: 'B', selected: true },
    ];
    // Capture original state
    const originalA = items[0].selected;
    const originalB = items[1].selected;

    let keyIdx = 0;
    const keys = [
      { name: 'space' },  // toggle item 0
      { name: 'return' }, // confirm
    ];
    const mockIO = {
      write(_: string) {},
      async readKey() {
        if (keyIdx >= keys.length) return { name: 'return', ctrl: false, shift: false };
        const k = keys[keyIdx++];
        return { name: k.name, ctrl: false, shift: false };
      },
      clearScreen() {},
      close() {},
    };

    await multiSelect(mockIO, 'test', items);

    // Original items must be unchanged
    assert.equal(items[0].selected, originalA, 'items[0].selected was mutated');
    assert.equal(items[1].selected, originalB, 'items[1].selected was mutated');
  });
});
