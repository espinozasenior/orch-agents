/**
 * Phase 9F -- tests for task router: routing, dream deferral, monitor auto-restart.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TaskType, TaskStatus } from '../../../src/execution/task/types';
import { createTask } from '../../../src/execution/task/taskFactory';
import { createTaskRouter, type TaskExecutor } from '../../../src/execution/task/taskRouter';

function mockExecutor(result?: Partial<import('../../../src/execution/runtime/task-executor').TaskExecutionResult>): TaskExecutor {
  return {
    execute: mock.fn(async () => ({
      status: 'completed' as const,
      output: 'ok',
      duration: 10,
      ...result,
    })),
    hasCapacity: () => true,
  };
}

function failingExecutor(error: string): TaskExecutor {
  return {
    execute: mock.fn(async () => { throw new Error(error); }),
    hasCapacity: () => true,
  };
}

describe('TaskRouter', () => {
  it('routes local_bash to the correct executor', async () => {
    const exec = mockExecutor();
    const router = createTaskRouter(new Map([[TaskType.local_bash, exec]]));
    const task = createTask(TaskType.local_bash);
    const result = await router.dispatch(task);
    assert.equal(result.status, 'completed');
    assert.equal((exec.execute as ReturnType<typeof mock.fn>).mock.callCount(), 1);
  });

  it('throws for unknown task type', async () => {
    const router = createTaskRouter(new Map());
    const task = createTask(TaskType.local_bash);
    await assert.rejects(
      () => router.dispatch(task),
      { message: /No executor registered/ },
    );
  });

  it('defers dream task when no capacity', async () => {
    const exec: TaskExecutor = {
      execute: mock.fn(async () => ({ status: 'completed' as const, output: 'ok', duration: 0 })),
      hasCapacity: () => false,
    };
    const router = createTaskRouter(new Map([[TaskType.dream, exec]]));
    const task = createTask(TaskType.dream);
    const result = await router.dispatch(task);
    assert.equal(result.status, 'cancelled');
    assert.ok(result.output.includes('deferred'));
    assert.equal((exec.execute as ReturnType<typeof mock.fn>).mock.callCount(), 0);
  });

  it('dispatches dream task when capacity is available', async () => {
    const exec = mockExecutor();
    const router = createTaskRouter(new Map([[TaskType.dream, exec]]));
    const task = createTask(TaskType.dream);
    const result = await router.dispatch(task);
    assert.equal(result.status, 'completed');
  });

  it('retries task with maxRetries > 0 on failure', async () => {
    let callCount = 0;
    const exec: TaskExecutor = {
      execute: mock.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return { status: 'completed' as const, output: 'ok', duration: 10 };
      }),
      hasCapacity: () => true,
    };
    const router = createTaskRouter(new Map([[TaskType.local_bash, exec]]));
    const task = createTask(TaskType.local_bash); // maxRetries=3
    const result = await router.dispatch(task);
    assert.equal(result.status, 'completed');
    assert.ok(callCount >= 2);
  });

  it('fails task when retries exhausted', async () => {
    const exec = failingExecutor('permanent');
    const router = createTaskRouter(new Map([[TaskType.local_workflow, exec]]));
    const task = createTask(TaskType.local_workflow); // maxRetries=0
    const result = await router.dispatch(task);
    assert.equal(result.status, 'failed');
    assert.ok(result.error?.includes('permanent'));
  });

  it('transitions task to running during dispatch', async () => {
    const exec = mockExecutor();
    const router = createTaskRouter(new Map([[TaskType.local_bash, exec]]));
    const task = createTask(TaskType.local_bash);
    assert.equal(task.status, TaskStatus.pending);
    await router.dispatch(task);
    // After dispatch the task object was mutated to running (or final state)
    assert.notEqual(task.status, TaskStatus.pending);
  });
});
