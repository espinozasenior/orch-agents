/**
 * Deliberate test failure — the agent should fix this automatically.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Math validation', () => {
  it('should correctly add two numbers', () => {
    const result = 1 + 1;
    assert.equal(result, 2, 'Basic addition check');
  });
});
