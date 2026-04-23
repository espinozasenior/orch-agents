/**
 * Deliberate test failure — the agent should attempt to fix this.
 * The fix is obvious: change the expected value from 3 to 2.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Math validation', () => {
  it('should correctly add two numbers', () => {
    const result = 1 + 1;
    assert.equal(result, 3, 'Basic addition is broken');
  });
});
