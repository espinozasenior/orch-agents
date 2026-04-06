/**
 * Phase 9F -- Task router: dispatches tasks to type-specific executors.
 *
 * Handles:
 * - Type-based routing to executor map
 * - dream tasks: deferred when no capacity
 * - monitor_mcp tasks: auto-restart with 30s backoff on failure
 */

import { TaskType, TaskStatus, type Task } from './types';
import { transition } from './taskStateMachine';
import type { TaskExecutionResult } from '../runtime/task-executor';

// ---------------------------------------------------------------------------
// Executor interface (matches existing TaskExecutor shape loosely)
// ---------------------------------------------------------------------------

export interface TaskExecutor {
  execute(task: Task): Promise<TaskExecutionResult>;
  /** Optional capacity check (for dream deferral). */
  hasCapacity?(): boolean;
}

// ---------------------------------------------------------------------------
// Router interface
// ---------------------------------------------------------------------------

export interface TaskRouter {
  dispatch(task: Task): Promise<TaskExecutionResult>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskRouter(
  executors: Map<TaskType, TaskExecutor>,
): TaskRouter {
  return {
    async dispatch(task: Task): Promise<TaskExecutionResult> {
      const executor = executors.get(task.type);
      if (!executor) {
        throw new Error(`No executor registered for task type: ${task.type}`);
      }

      // Dream tasks: defer when no capacity
      if (task.type === TaskType.dream && executor.hasCapacity && !executor.hasCapacity()) {
        return {
          status: 'cancelled',
          output: 'Dream task deferred: no capacity available',
          duration: 0,
        };
      }

      // Transition to running
      const running = transition(task, TaskStatus.running);
      // Mutate the original task reference for callers that hold it
      Object.assign(task, { status: running.status, updatedAt: running.updatedAt, startedAt: running.startedAt });

      try {
        const result = await executor.execute(running);
        return result;
      } catch (err) {
        // monitor_mcp: auto-restart with 30s backoff
        if (task.type === TaskType.monitor_mcp) {
          return new Promise<TaskExecutionResult>((resolve) => {
            setTimeout(() => {
              // Reset status to pending for re-dispatch
              Object.assign(task, { status: TaskStatus.pending, updatedAt: Date.now() });
              resolve(createTaskRouter(executors).dispatch(task));
            }, 30_000);
          });
        }

        // Regular tasks with retries remaining
        if (task.metadata.maxRetries > 0) {
          task.metadata.maxRetries--;
          Object.assign(task, { status: TaskStatus.pending, updatedAt: Date.now() });
          return createTaskRouter(executors).dispatch(task);
        }

        // No retries left -- fail
        Object.assign(task, { status: TaskStatus.failed, updatedAt: Date.now(), completedAt: Date.now() });
        return {
          status: 'failed',
          output: '',
          duration: Date.now() - task.createdAt,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
