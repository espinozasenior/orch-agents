/**
 * Tests for the task-notification XML parser.
 *
 * Validates parsing of complete notifications, handling of
 * optional fields, and the isTaskNotification detector.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTaskNotification,
  isTaskNotification,
} from '../../src/coordinator/notificationParser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildNotificationXml(opts: {
  taskId?: string;
  status?: string;
  summary?: string;
  result?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}): string {
  let xml = '<task-notification>';
  if (opts.taskId) xml += `<task-id>${opts.taskId}</task-id>`;
  if (opts.status) xml += `<status>${opts.status}</status>`;
  if (opts.summary) xml += `<summary>${opts.summary}</summary>`;
  if (opts.result) xml += `<result>${opts.result}</result>`;
  if (opts.usage) {
    xml += '<usage>';
    xml += `<total-tokens>${opts.usage.totalTokens}</total-tokens>`;
    xml += `<tool-uses>${opts.usage.toolUses}</tool-uses>`;
    xml += `<duration-ms>${opts.usage.durationMs}</duration-ms>`;
    xml += '</usage>';
  }
  xml += '</task-notification>';
  return xml;
}

// ---------------------------------------------------------------------------
// parseTaskNotification
// ---------------------------------------------------------------------------

describe('parseTaskNotification', () => {
  it('should parse a complete task-notification with all fields', () => {
    const xml = buildNotificationXml({
      taskId: 'worker-001',
      status: 'completed',
      summary: 'Found null pointer in auth.ts:42',
      result: 'User field is undefined when session expires',
      usage: { totalTokens: 5000, toolUses: 12, durationMs: 3400 },
    });

    const notification = parseTaskNotification(xml);

    assert.equal(notification.taskId, 'worker-001');
    assert.equal(notification.status, 'completed');
    assert.equal(notification.summary, 'Found null pointer in auth.ts:42');
    assert.equal(notification.result, 'User field is undefined when session expires');
    assert.ok(notification.usage);
    assert.equal(notification.usage.totalTokens, 5000);
    assert.equal(notification.usage.toolUses, 12);
    assert.equal(notification.usage.durationMs, 3400);
  });

  it('should handle missing optional fields (result, usage)', () => {
    const xml = buildNotificationXml({
      taskId: 'worker-002',
      status: 'failed',
      summary: 'Build failed with 3 errors',
    });

    const notification = parseTaskNotification(xml);

    assert.equal(notification.taskId, 'worker-002');
    assert.equal(notification.status, 'failed');
    assert.equal(notification.summary, 'Build failed with 3 errors');
    assert.equal(notification.result, undefined);
    assert.equal(notification.usage, undefined);
  });

  it('should parse killed status', () => {
    const xml = buildNotificationXml({
      taskId: 'worker-003',
      status: 'killed',
      summary: 'Worker exceeded time limit',
    });

    const notification = parseTaskNotification(xml);
    assert.equal(notification.status, 'killed');
  });

  it('should throw on missing task-notification element', () => {
    assert.throws(
      () => parseTaskNotification('some random text'),
      /No <task-notification> element found/,
    );
  });

  it('should throw on missing required task-id', () => {
    const xml = buildNotificationXml({
      status: 'completed',
      summary: 'done',
    });
    assert.throws(
      () => parseTaskNotification(xml),
      /Missing required <task-id>/,
    );
  });

  it('should throw on invalid status value', () => {
    const xml = '<task-notification><task-id>w1</task-id><status>running</status><summary>s</summary></task-notification>';
    assert.throws(
      () => parseTaskNotification(xml),
      /Invalid status/,
    );
  });

  it('should handle notification embedded in surrounding text', () => {
    const text = `Here are my findings:\n${buildNotificationXml({
      taskId: 'w-embedded',
      status: 'completed',
      summary: 'All good',
    })}\nEnd of report.`;

    const notification = parseTaskNotification(text);
    assert.equal(notification.taskId, 'w-embedded');
  });
});

// ---------------------------------------------------------------------------
// isTaskNotification
// ---------------------------------------------------------------------------

describe('isTaskNotification', () => {
  it('should return true for text containing a task-notification', () => {
    const xml = buildNotificationXml({
      taskId: 'w1',
      status: 'completed',
      summary: 'done',
    });
    assert.equal(isTaskNotification(xml), true);
  });

  it('should return true when notification is embedded in other text', () => {
    const text = `Some preamble\n${buildNotificationXml({
      taskId: 'w2',
      status: 'failed',
      summary: 'oops',
    })}\nSome postamble`;
    assert.equal(isTaskNotification(text), true);
  });

  it('should return false for text without a task-notification', () => {
    assert.equal(isTaskNotification('Just a regular message'), false);
  });

  it('should return false for partial/malformed tags', () => {
    assert.equal(isTaskNotification('<task-notification>incomplete'), false);
  });
});
