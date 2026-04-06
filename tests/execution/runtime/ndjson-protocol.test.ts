/**
 * TDD: Tests for NDJSON wire protocol.
 *
 * Phase 9B: Bridge-Harness Separation (FR-9B.03)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeMessage,
  decodeMessage,
  isTaskMessage,
  isResultMessage,
  isPermissionRequestMessage,
  isPermissionResponseMessage,
  isStatusMessage,
  isErrorMessage,
  type AnyMessage,
  type TaskMessage,
  type ResultMessage,
} from '../../../src/execution/runtime/ndjson-protocol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTaskMessage(overrides: Partial<TaskMessage> = {}): TaskMessage {
  return {
    type: 'task',
    id: 't-1',
    sessionId: 's-1',
    payload: { tool: 'Edit', args: { file: 'test.ts' } },
    timestamp: 1711900000,
    ...overrides,
  };
}

function makeResultMessage(overrides: Partial<ResultMessage> = {}): ResultMessage {
  return {
    type: 'result',
    id: 'r-1',
    sessionId: 's-1',
    payload: { success: true, output: 'done' },
    timestamp: 1711900001,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NdjsonProtocol', () => {
  // -----------------------------------------------------------------------
  // Encoding
  // -----------------------------------------------------------------------

  describe('encodeMessage', () => {
    it('serializes to single-line JSON ending with newline', () => {
      const msg = makeTaskMessage();
      const encoded = encodeMessage(msg);
      assert.ok(encoded.endsWith('\n'), 'Must end with newline');
      assert.ok(!encoded.slice(0, -1).includes('\n'), 'No newlines in JSON body');
    });

    it('produces valid JSON', () => {
      const msg = makeTaskMessage();
      const encoded = encodeMessage(msg);
      const parsed = JSON.parse(encoded.trim());
      assert.equal(parsed.type, 'task');
      assert.equal(parsed.id, 't-1');
    });

    it('round-trips through encode -> decode', () => {
      const msg = makeTaskMessage();
      const encoded = encodeMessage(msg);
      const decoded = decodeMessage(encoded);
      assert.equal(decoded.type, msg.type);
      assert.equal(decoded.id, msg.id);
      assert.equal(decoded.sessionId, msg.sessionId);
    });
  });

  // -----------------------------------------------------------------------
  // Decoding
  // -----------------------------------------------------------------------

  describe('decodeMessage', () => {
    it('parses valid task envelope', () => {
      const json = JSON.stringify(makeTaskMessage());
      const msg = decodeMessage(json);
      assert.equal(msg.type, 'task');
      assert.equal(msg.id, 't-1');
    });

    it('parses valid result envelope', () => {
      const json = JSON.stringify(makeResultMessage());
      const msg = decodeMessage(json);
      assert.equal(msg.type, 'result');
    });

    it('handles all 6 message types', () => {
      const types = ['task', 'result', 'permission_request', 'permission_response', 'status', 'error'] as const;
      for (const type of types) {
        const json = JSON.stringify({
          type,
          id: `id-${type}`,
          sessionId: 's-1',
          payload: {},
          timestamp: Date.now(),
        });
        const msg = decodeMessage(json);
        assert.equal(msg.type, type);
      }
    });

    it('trims whitespace from input', () => {
      const json = '  ' + JSON.stringify(makeTaskMessage()) + '  \n';
      const msg = decodeMessage(json);
      assert.equal(msg.type, 'task');
    });

    it('rejects empty line', () => {
      assert.throws(() => decodeMessage(''), { message: /Empty NDJSON line/ });
    });

    it('rejects invalid JSON', () => {
      assert.throws(() => decodeMessage('{broken'), { message: /Invalid JSON/ });
    });

    it('rejects non-object JSON', () => {
      assert.throws(() => decodeMessage('"hello"'), { message: /must be a JSON object/ });
    });

    it('rejects envelope with missing type field', () => {
      const json = JSON.stringify({ id: '1', sessionId: 's-1', payload: {}, timestamp: 1 });
      assert.throws(() => decodeMessage(json), { message: /missing required "type" field/ });
    });

    it('rejects envelope with unknown type value', () => {
      const json = JSON.stringify({ type: 'banana', id: '1', sessionId: 's-1', payload: {}, timestamp: 1 });
      assert.throws(() => decodeMessage(json), { message: /Unknown NDJSON message type: banana/ });
    });

    it('rejects envelope with missing id field', () => {
      const json = JSON.stringify({ type: 'task', sessionId: 's-1', payload: {}, timestamp: 1 });
      assert.throws(() => decodeMessage(json), { message: /missing required "id" field/ });
    });

    it('rejects envelope with missing sessionId field', () => {
      const json = JSON.stringify({ type: 'task', id: '1', payload: {}, timestamp: 1 });
      assert.throws(() => decodeMessage(json), { message: /missing required "sessionId" field/ });
    });

    it('rejects envelope with missing timestamp field', () => {
      const json = JSON.stringify({ type: 'task', id: '1', sessionId: 's-1', payload: {} });
      assert.throws(() => decodeMessage(json), { message: /missing required "timestamp" field/ });
    });
  });

  // -----------------------------------------------------------------------
  // Type guards
  // -----------------------------------------------------------------------

  describe('type guards', () => {
    it('isTaskMessage returns true for task', () => {
      const msg = makeTaskMessage();
      assert.equal(isTaskMessage(msg), true);
      assert.equal(isResultMessage(msg), false);
    });

    it('isResultMessage returns true for result', () => {
      const msg = makeResultMessage();
      assert.equal(isResultMessage(msg), true);
      assert.equal(isTaskMessage(msg), false);
    });

    it('isPermissionRequestMessage identifies correctly', () => {
      const msg: AnyMessage = {
        type: 'permission_request',
        id: 'pr-1',
        sessionId: 's-1',
        payload: { tool: 'Bash', command: 'echo hi' },
        timestamp: Date.now(),
      };
      assert.equal(isPermissionRequestMessage(msg), true);
      assert.equal(isPermissionResponseMessage(msg), false);
    });

    it('isPermissionResponseMessage identifies correctly', () => {
      const msg: AnyMessage = {
        type: 'permission_response',
        id: 'pr-1',
        sessionId: 's-1',
        payload: { approved: true },
        timestamp: Date.now(),
      };
      assert.equal(isPermissionResponseMessage(msg), true);
    });

    it('isStatusMessage identifies correctly', () => {
      const msg: AnyMessage = {
        type: 'status',
        id: 'st-1',
        sessionId: 's-1',
        payload: { tokensUsed: 100 },
        timestamp: Date.now(),
      };
      assert.equal(isStatusMessage(msg), true);
    });

    it('isErrorMessage identifies correctly', () => {
      const msg: AnyMessage = {
        type: 'error',
        id: 'e-1',
        sessionId: 's-1',
        payload: { code: 'ERR_TIMEOUT', message: 'timed out' },
        timestamp: Date.now(),
      };
      assert.equal(isErrorMessage(msg), true);
    });
  });
});
