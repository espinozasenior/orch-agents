/**
 * TDD: Tests for SessionStateMachine — pure state transition validation.
 *
 * Phase 9B: Bridge-Harness Separation (FR-9B.04)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionTransition,
  isValidTransition,
  reachableStates,
  type SessionState,
} from '../../../src/execution/runtime/session-state-machine';

describe('SessionStateMachine', () => {
  // -------------------------------------------------------------------------
  // Valid transitions
  // -------------------------------------------------------------------------

  describe('valid transitions', () => {
    const validCases: Array<[SessionState, SessionState]> = [
      ['idle', 'working'],
      ['idle', 'draining'],
      ['idle', 'failed'],
      ['working', 'idle'],
      ['working', 'requires_action'],
      ['working', 'draining'],
      ['working', 'failed'],
      ['requires_action', 'working'],
      ['requires_action', 'draining'],
      ['requires_action', 'failed'],
      ['draining', 'idle'],
      ['draining', 'failed'],
    ];

    for (const [from, to] of validCases) {
      it(`allows ${from} -> ${to}`, () => {
        const result = sessionTransition(from, to);
        assert.equal(result.from, from);
        assert.equal(result.to, to);
        assert.equal(typeof result.timestamp, 'number');
      });
    }
  });

  // -------------------------------------------------------------------------
  // Identity transitions (same state)
  // -------------------------------------------------------------------------

  describe('identity transitions', () => {
    const states: SessionState[] = ['idle', 'working', 'requires_action', 'draining', 'failed'];

    for (const state of states) {
      it(`allows ${state} -> ${state} (no-op)`, () => {
        const result = sessionTransition(state, state);
        assert.equal(result.from, state);
        assert.equal(result.to, state);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Invalid transitions
  // -------------------------------------------------------------------------

  describe('invalid transitions', () => {
    const invalidCases: Array<[SessionState, SessionState]> = [
      ['idle', 'requires_action'],     // must go through working first
      ['failed', 'idle'],              // terminal state
      ['failed', 'working'],
      ['failed', 'requires_action'],
      ['failed', 'draining'],
      ['draining', 'working'],
      ['draining', 'requires_action'],
    ];

    for (const [from, to] of invalidCases) {
      it(`rejects ${from} -> ${to}`, () => {
        assert.throws(
          () => sessionTransition(from, to),
          { message: `Invalid session state transition: ${from} -> ${to}` },
        );
      });
    }
  });

  // -------------------------------------------------------------------------
  // isValidTransition
  // -------------------------------------------------------------------------

  describe('isValidTransition', () => {
    it('returns true for valid transitions', () => {
      assert.equal(isValidTransition('idle', 'working'), true);
      assert.equal(isValidTransition('working', 'idle'), true);
    });

    it('returns false for invalid transitions', () => {
      assert.equal(isValidTransition('failed', 'idle'), false);
      assert.equal(isValidTransition('idle', 'requires_action'), false);
    });

    it('returns true for identity transitions', () => {
      assert.equal(isValidTransition('idle', 'idle'), true);
      assert.equal(isValidTransition('failed', 'failed'), true);
    });
  });

  // -------------------------------------------------------------------------
  // reachableStates
  // -------------------------------------------------------------------------

  describe('reachableStates', () => {
    it('idle can reach working, draining, failed', () => {
      const states = reachableStates('idle');
      assert.ok(states.includes('working'));
      assert.ok(states.includes('draining'));
      assert.ok(states.includes('failed'));
      assert.equal(states.length, 3);
    });

    it('failed has no reachable states', () => {
      const states = reachableStates('failed');
      assert.equal(states.length, 0);
    });

    it('working can reach idle, requires_action, draining, failed', () => {
      const states = reachableStates('working');
      assert.equal(states.length, 4);
    });
  });
});
