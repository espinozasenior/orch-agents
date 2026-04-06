/**
 * Phase 9F -- tests for task ID generation and task creation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskType, TaskStatus, TASK_TYPE_PREFIX } from '../../../src/execution/task/types';
import { createTaskId, parseTaskType, createTask } from '../../../src/execution/task/taskFactory';

describe('createTaskId', () => {
  it('generates an ID matching {prefix}-{32 hex} for local_bash', () => {
    const id = createTaskId(TaskType.local_bash);
    assert.match(id, /^lb-[a-f0-9]{32}$/);
  });

  it('generates an ID matching {prefix}-{32 hex} for dream', () => {
    const id = createTaskId(TaskType.dream);
    assert.match(id, /^dr-[a-f0-9]{32}$/);
  });

  it('generates unique IDs on consecutive calls', () => {
    const a = createTaskId(TaskType.local_agent);
    const b = createTaskId(TaskType.local_agent);
    assert.notEqual(a, b);
  });

  it('uses correct prefix for every type', () => {
    for (const type of Object.values(TaskType)) {
      const id = createTaskId(type);
      const expectedPrefix = TASK_TYPE_PREFIX[type];
      assert.ok(id.startsWith(`${expectedPrefix}-`), `${type} should start with ${expectedPrefix}-`);
    }
  });
});

describe('parseTaskType', () => {
  it('round-trips for all task types', () => {
    for (const type of Object.values(TaskType)) {
      const id = createTaskId(type);
      assert.equal(parseTaskType(id), type);
    }
  });

  it('returns undefined for unknown prefix', () => {
    assert.equal(parseTaskType('xx-0123456789abcdef0123456789abcdef'), undefined);
  });

  it('returns undefined for string without dash', () => {
    assert.equal(parseTaskType('noprefixhere'), undefined);
  });
});

describe('createTask', () => {
  it('creates a task with correct type', () => {
    const task = createTask(TaskType.remote_agent);
    assert.equal(task.type, TaskType.remote_agent);
  });

  it('creates a task in pending state', () => {
    const task = createTask(TaskType.local_bash);
    assert.equal(task.status, TaskStatus.pending);
  });

  it('ID has the correct type prefix', () => {
    const task = createTask(TaskType.local_workflow);
    assert.ok(task.id.startsWith('lw-'));
  });

  it('has createdAt and updatedAt timestamps', () => {
    const before = Date.now();
    const task = createTask(TaskType.dream);
    const after = Date.now();
    assert.ok(task.createdAt >= before && task.createdAt <= after);
    assert.ok(task.updatedAt >= before && task.updatedAt <= after);
  });

  it('merges metadata overrides', () => {
    const task = createTask(TaskType.local_bash, { maxRetries: 10 });
    assert.equal(task.metadata.maxRetries, 10);
    // Other defaults preserved
    assert.equal(task.metadata.concurrencyClass, 'shell');
  });
});
