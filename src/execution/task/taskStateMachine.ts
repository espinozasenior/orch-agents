/**
 * Phase 9F -- Task state machine: pure-function transitions with event emission.
 *
 * Valid transitions:
 *   pending  -> running | cancelled
 *   running  -> completed | failed | cancelled
 *   completed, failed, cancelled -> (none -- terminal)
 */

import { TaskStatus, type Task } from './types';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Cannot transition from '${from}' to '${to}'`);
    this.name = 'InvalidTransitionError';
  }
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<TaskStatus, ReadonlyArray<TaskStatus>> = {
  [TaskStatus.pending]: [TaskStatus.running, TaskStatus.cancelled],
  [TaskStatus.running]: [TaskStatus.completed, TaskStatus.failed, TaskStatus.cancelled],
  [TaskStatus.completed]: [],
  [TaskStatus.failed]: [],
  [TaskStatus.cancelled]: [],
};

// ---------------------------------------------------------------------------
// Transition event
// ---------------------------------------------------------------------------

export interface TaskStateTransitionEvent {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Transition handler callback type
// ---------------------------------------------------------------------------

export type TransitionListener = (event: TaskStateTransitionEvent) => void;

// ---------------------------------------------------------------------------
// Pure transition function
// ---------------------------------------------------------------------------

/**
 * Transition a task to a new status.
 *
 * Returns a **new** Task object (no mutation of the original).
 * Throws `InvalidTransitionError` when the transition is not allowed.
 *
 * If an optional `listener` is provided it is called synchronously with
 * the transition event after the new task is created.
 */
export function transition(
  task: Task,
  target: TaskStatus,
  listener?: TransitionListener,
): Task {
  const allowed = VALID_TRANSITIONS[task.status];
  if (!allowed.includes(target)) {
    throw new InvalidTransitionError(task.status, target);
  }

  const now = Date.now();
  const updated: Task = {
    ...task,
    status: target,
    updatedAt: now,
    ...(target === TaskStatus.running ? { startedAt: now } : {}),
    ...(target === TaskStatus.completed ||
    target === TaskStatus.failed ||
    target === TaskStatus.cancelled
      ? { completedAt: now }
      : {}),
  };

  if (listener) {
    listener({
      taskId: task.id,
      from: task.status,
      to: target,
      timestamp: now,
    });
  }

  return updated;
}
