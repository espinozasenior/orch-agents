/**
 * Tests for shared/agent-identity.ts — AIG compliance identity badge.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We need to test with default env (no BOT_USERNAME set).
// The module reads process.env.BOT_USERNAME at import time,
// so we test the default behavior here.

import {
  formatAgentComment,
  isAgentComment,
  getBotName,
  getBotMarker,
} from '../../src/shared/agent-identity';

describe('agent-identity', () => {
  describe('formatAgentComment', () => {
    it('appends bot marker to body', () => {
      const body = 'Agent **coder** completed work.';
      const result = formatAgentComment(body);

      assert.ok(result.startsWith(body), 'Should start with the original body');
      assert.ok(
        result.includes(getBotMarker()),
        'Should include the bot marker',
      );
    });
  });

  describe('isAgentComment', () => {
    it('returns true for comments with bot marker', () => {
      const marker = getBotMarker();
      const comment = `Some text\n${marker}`;
      assert.equal(isAgentComment(comment), true);
    });

    it('returns false for comments without bot marker', () => {
      assert.equal(isAgentComment('Just a normal comment'), false);
    });

    it('returns false for empty string', () => {
      assert.equal(isAgentComment(''), false);
    });
  });

  describe('getBotName', () => {
    it('returns default bot name when BOT_USERNAME is not set', () => {
      // BOT_USERNAME may or may not be set in the test environment.
      // The function should return a non-empty string either way.
      const name = getBotName();
      assert.ok(name.length > 0, 'Bot name should be non-empty');
      assert.equal(typeof name, 'string');
    });
  });

  describe('getBotMarker', () => {
    it('returns an HTML comment marker', () => {
      const marker = getBotMarker();
      assert.ok(marker.startsWith('<!--'), 'Marker should start with HTML comment');
      assert.ok(marker.endsWith('-->'), 'Marker should end with HTML comment');
      assert.ok(marker.includes('-bot'), 'Marker should contain -bot suffix');
    });
  });
});
