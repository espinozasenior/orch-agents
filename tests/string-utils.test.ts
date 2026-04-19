/**
 * String utility tests — has a bug the agent should fix.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

describe('capitalize', () => {
  it('should capitalize first letter', () => {
    assert.equal(capitalize('hello'), 'Hello');
  });

  it('should handle empty string', () => {
    assert.equal(capitalize(''), '');
  });

  it('should handle already capitalized', () => {
    assert.equal(capitalize('World'), 'world'); // BUG: expected should be 'World' not 'world'
  });
});
