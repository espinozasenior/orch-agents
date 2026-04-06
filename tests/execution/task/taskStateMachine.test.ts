/**
 * Phase 9F -- tests for task state machine transitions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TaskStatus } from '../../../src/execution/task/types';
import { createTask } from '../../../src/execution/task/taskFactory';
import { TaskType } from '../../../src/execution/task/types';
import {
  transition,
  InvalidTransitionError,
  type TaskStateTransitionEvent,
} from '../../../src/execution/task/taskStateMachine';

function pendingTask() {
  return createTask(TaskType.local_bash);
}

describe('transition (valid)', () => {
  it('pending -> running', () => {
    const task = pendingTask();
    const result = transition(task, TaskStatus.running);
    assert.equal(result.status, TaskStatus.running);
  });

  it('pending -> cancelled', () => {
    const task = pendingTask();
    const result = transition(task, TaskStatus.cancelled);
    assert.equal(result.status, TaskStatus.cancelled);
  });

  it('running -> completed', () => {
    const task = pendingTask();
    const running = transition(task, TaskStatus.running);
    const result = transition(running, TaskStatus.completed);
    assert.equal(result.status, TaskStatus.completed);
  });

  it('running -> failed', () => {
    const task = pendingTask();
    const running = transition(task, TaskStatus.running);
    const result = transition(running, TaskStatus.failed);
    assert.equal(result.status, TaskStatus.failed);
  });

  it('running -> cancelled', () => {
    const task = pendingTask();
    const running = transition(task, TaskStatus.running);
    const result = transition(running, TaskStatus.cancelled);
    assert.equal(result.status, TaskStatus.cancelled);
  });
});

describe('transition (invalid)', () => {
  it('completed -> running throws InvalidTransitionError', () => {
    const task = pendingTask();
    const running = transition(task, TaskStatus.running);
    const completed = transition(running, TaskStatus.completed);
    assert.throws(
      () => transition(completed, TaskStatus.running),
      InvalidTransitionError,
    );
  });

  it('failed -> running throws InvalidTransitionError', () => {
    const task = pendingTask();
    const running = transition(task, TaskStatus.running);
    const failed = transition(running, TaskStatus.failed);
    assert.throws(
      () => transition(failed, TaskStatus.running),
      InvalidTransitionError,
    );
  });

  it('cancelled -> running throws InvalidTransitionError', () => {
    const task = pendingTask();
    const cancelled = transition(task, TaskStatus.cancelled);
    assert.throws(
      () => transition(cancelled, TaskStatus.running),
      InvalidTransitionError,
    );
  });

  it('pending -> completed throws (must go through running)', () => {
    const task = pendingTask();
    assert.throws(
      () => transition(task, TaskStatus.completed),
      InvalidTransitionError,
    );
  });

  it('pending -> failed throws', () => {
    const task = pendingTask();
    assert.throws(
      () => transition(task, TaskStatus.failed),
      InvalidTransitionError,
    );
  });
});

describe('transition immutability', () => {
  it('does not mutate the original task', () => {
    const task = pendingTask();
    const _running = transition(task, TaskStatus.running);
    assert.equal(task.status, TaskStatus.pending);
  });
});

describe('transition event emission', () => {
  it('calls listener with from, to, taskId, and timestamp', () => {
    const task = pendingTask();
    const events: TaskStateTransitionEvent[] = [];
    transition(task, TaskStatus.running, (e) => events.push(e));
    assert.equal(events.length, 1);
    assert.equal(events[0].from, TaskStatus.pending);
    assert.equal(events[0].to, TaskStatus.running);
    assert.equal(events[0].taskId, task.id);
    assert.ok(typeof events[0].timestamp === 'number');
  });

  it('does not call listener on invalid transition', () => {
    const task = pendingTask();
    const running = transition(task, TaskStatus.running);
    const completed = transition(running, TaskStatus.completed);
    const events: TaskStateTransitionEvent[] = [];
    assert.throws(() => transition(completed, TaskStatus.running, (e) => events.push(e)));
    assert.equal(events.length, 0);
  });
});

describe('transition timestamps', () => {
  it('sets startedAt when transitioning to running', () => {
    const task = pendingTask();
    const running = transition(task, TaskStatus.running);
    assert.ok(running.startedAt);
  });

  it('sets completedAt when transitioning to completed', () => {
    const task = pendingTask();
    const running = transition(task, TaskStatus.running);
    const completed = transition(running, TaskStatus.completed);
    assert.ok(completed.completedAt);
  });

  it('sets completedAt when transitioning to failed', () => {
    const task = pendingTask();
    const running = transition(task, TaskStatus.running);
    const failed = transition(running, TaskStatus.failed);
    assert.ok(failed.completedAt);
  });

  it('sets completedAt when transitioning to cancelled', () => {
    const task = pendingTask();
    const cancelled = transition(task, TaskStatus.cancelled);
    assert.ok(cancelled.completedAt);
  });
});
