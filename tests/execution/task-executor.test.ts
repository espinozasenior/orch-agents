/**
 * TDD: Tests for TaskExecutor — extractJson and type definitions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJson,
} from '../../src/execution/runtime/task-executor';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskExecutor', () => {
  describe('extractJson() — hook pollution hardening', () => {
    it('preserves existing behavior for clean JSON input', () => {
      const input = '{"valid": true}';
      const result = extractJson(input);
      assert.equal(result, '{"valid": true}');
    });

    it('preserves existing behavior for fenced JSON input', () => {
      const input = '```json\n{"fenced": true}\n```';
      const result = extractJson(input);
      assert.equal(result, '{"fenced": true}');
    });

    it('extracts JSON correctly when preceded by hook output lines', () => {
      const input = [
        '[hook: session-start] Restoring session...',
        'Session restored from backup',
        'Memory imported from project',
        '{"valid": true}',
      ].join('\n');
      const result = extractJson(input);
      assert.ok(result !== undefined, 'Should extract JSON');
      assert.deepEqual(JSON.parse(result!), { valid: true });
    });

    it('extracts JSON correctly when followed by hook output lines', () => {
      const input = [
        '{"valid": true}',
        '[hook: session-end] consolidating...',
        'Intelligence consolidated',
        'Auto-memory synced',
      ].join('\n');
      const result = extractJson(input);
      assert.ok(result !== undefined, 'Should extract JSON');
      assert.deepEqual(JSON.parse(result!), { valid: true });
    });

    it('extracts JSON correctly when interleaved with hook output', () => {
      const input = [
        '[hook: session-start] Restoring session...',
        'Session restored from backup',
        '{"result": "success", "count": 42}',
        '[hook: session-end] consolidating...',
        'Intelligence consolidated',
      ].join('\n');
      const result = extractJson(input);
      assert.ok(result !== undefined, 'Should extract JSON');
      assert.deepEqual(JSON.parse(result!), { result: 'success', count: 42 });
    });

    it('identifies [hook: ...] patterns', () => {
      const input = '[hook: session-start] Restoring session...\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('identifies "Session restored" pattern', () => {
      const input = 'Session restored from backup\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('identifies "Memory imported" pattern', () => {
      const input = 'Memory imported from project\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('identifies "Intelligence consolidated" pattern', () => {
      const input = 'Intelligence consolidated\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('identifies "Auto-memory synced" pattern', () => {
      const input = 'Auto-memory synced\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('identifies bracketed hook patterns like [SessionEnd hook]', () => {
      const input = '[SessionEnd hook] running cleanup\n{"ok": true}';
      const result = extractJson(input);
      assert.ok(result !== undefined);
      assert.deepEqual(JSON.parse(result!), { ok: true });
    });

    it('does NOT strip legitimate JSON containing the word "hook"', () => {
      const input = '{"hookEnabled": true, "type": "webhook"}';
      const result = extractJson(input);
      assert.ok(result !== undefined, 'Should not strip legitimate JSON');
      assert.deepEqual(JSON.parse(result!), { hookEnabled: true, type: 'webhook' });
    });

    it('returns undefined for input that is only hook output', () => {
      const input = [
        '[hook: session-start] Restoring session...',
        'Session restored from backup',
        'Intelligence consolidated',
      ].join('\n');
      const result = extractJson(input);
      assert.equal(result, undefined);
    });
  });

});
