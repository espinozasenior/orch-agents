/**
 * Tests for shared/format.ts
 *
 * Covers formatDuration for milliseconds, seconds, and minutes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../../src/shared/format';

describe('formatDuration', () => {
  it('formats sub-second durations in milliseconds', () => {
    assert.strictEqual(formatDuration(0), '0ms');
    assert.strictEqual(formatDuration(1), '1ms');
    assert.strictEqual(formatDuration(999), '999ms');
  });

  it('formats durations in seconds', () => {
    assert.strictEqual(formatDuration(1000), '1s');
    assert.strictEqual(formatDuration(5000), '5s');
    assert.strictEqual(formatDuration(59000), '59s');
  });

  it('formats durations in minutes and seconds', () => {
    assert.strictEqual(formatDuration(60000), '1m 0s');
    assert.strictEqual(formatDuration(125000), '2m 5s');
    assert.strictEqual(formatDuration(3661000), '61m 1s');
  });

  it('truncates fractional seconds', () => {
    assert.strictEqual(formatDuration(1500), '1s');
    assert.strictEqual(formatDuration(2999), '2s');
  });

  it('handles exact boundary at 1000ms', () => {
    assert.strictEqual(formatDuration(999), '999ms');
    assert.strictEqual(formatDuration(1000), '1s');
  });

  it('handles exact boundary at 60s', () => {
    assert.strictEqual(formatDuration(59000), '59s');
    assert.strictEqual(formatDuration(60000), '1m 0s');
  });
});
