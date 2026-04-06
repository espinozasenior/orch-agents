/**
 * Phase 9F -- tests for task type definitions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TaskType,
  TaskStatus,
  TASK_TYPE_METADATA,
  TASK_TYPE_PREFIX,
  PREFIX_TO_TASK_TYPE,
} from '../../../src/execution/task/types';

describe('TaskType enum', () => {
  it('has exactly 7 task types', () => {
    const values = Object.values(TaskType);
    assert.equal(values.length, 7);
  });

  it('contains all expected types', () => {
    const expected = [
      'local_bash', 'local_agent', 'remote_agent',
      'in_process_teammate', 'local_workflow', 'monitor_mcp', 'dream',
    ];
    for (const t of expected) {
      assert.ok(Object.values(TaskType).includes(t as TaskType), `Missing type: ${t}`);
    }
  });
});

describe('TaskStatus enum', () => {
  it('has exactly 5 statuses', () => {
    assert.equal(Object.values(TaskStatus).length, 5);
  });
});

describe('TASK_TYPE_METADATA', () => {
  it('has metadata for every task type', () => {
    for (const type of Object.values(TaskType)) {
      assert.ok(TASK_TYPE_METADATA[type], `Missing metadata for ${type}`);
    }
  });

  it('monitor_mcp has infinite timeout and retries', () => {
    const meta = TASK_TYPE_METADATA[TaskType.monitor_mcp];
    assert.equal(meta.defaultTimeout, Infinity);
    assert.equal(meta.maxRetries, Infinity);
  });

  it('dream has lowest priority (highest number)', () => {
    const dreamPriority = TASK_TYPE_METADATA[TaskType.dream].priority;
    for (const type of Object.values(TaskType)) {
      assert.ok(
        TASK_TYPE_METADATA[type].priority <= dreamPriority,
        `${type} priority should be <= dream priority`,
      );
    }
  });
});

describe('TASK_TYPE_PREFIX', () => {
  it('has a 2-char prefix for every type', () => {
    for (const type of Object.values(TaskType)) {
      const prefix = TASK_TYPE_PREFIX[type];
      assert.ok(prefix, `Missing prefix for ${type}`);
      assert.equal(prefix.length, 2, `Prefix for ${type} should be 2 chars`);
    }
  });

  it('all prefixes are unique', () => {
    const prefixes = Object.values(TASK_TYPE_PREFIX);
    assert.equal(new Set(prefixes).size, prefixes.length, 'Duplicate prefix detected');
  });

  it('PREFIX_TO_TASK_TYPE is the exact inverse', () => {
    for (const [type, prefix] of Object.entries(TASK_TYPE_PREFIX)) {
      assert.equal(PREFIX_TO_TASK_TYPE[prefix], type);
    }
  });
});
