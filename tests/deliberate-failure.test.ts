/**
 * Deliberate test failure to test CI failure notification via Slack.
 * DELETE THIS FILE after testing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Deliberate CI failure', () => {
  it('should fail on purpose to test ci-status skill', () => {
    assert.equal(1 + 1, 3, 'This test is intentionally broken to trigger CI failure notification');
  });
});
