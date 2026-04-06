/**
 * P6 -- Task Registry: central in-memory store for Task lifecycle tracking.
 *
 * Provides register/get/update/list/evict operations over a Map<string, Task>.
 * Factory function returns a plain object (no class) per project conventions.
 */

import type { Task } from './types';
import { TaskStatus } from './types';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface TaskRegistry {
  /** Register a new task. Throws if a task with the same ID already exists. */
  register(task: Task): void;
  /** Retrieve a task by ID, or undefined if not found. */
  get(taskId: string): Task | undefined;
  /** Replace a task entry. Throws if the task ID is not registered. */
  update(taskId: string, task: Task): void;
  /** Return all tasks matching the given status. */
  listByStatus(status: TaskStatus): Task[];
  /** Record the current timestamp as "notified" for a terminal task. */
  markNotified(taskId: string): void;
  /**
   * Delete tasks whose notifiedAt timestamp is older than `graceMs`.
   * Returns the IDs of evicted tasks.
   */
  evictNotified(graceMs?: number): string[];
  /** Number of tasks currently stored. */
  readonly size: number;
}

// ---------------------------------------------------------------------------
// Default grace period (30 seconds)
// ---------------------------------------------------------------------------

const DEFAULT_GRACE_MS = 30_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskRegistry(): TaskRegistry {
  const tasks = new Map<string, Task>();
  const notifiedAt = new Map<string, number>();

  return {
    register(task: Task): void {
      if (tasks.has(task.id)) {
        throw new Error(`Task already registered: ${task.id}`);
      }
      tasks.set(task.id, task);
    },

    get(taskId: string): Task | undefined {
      return tasks.get(taskId);
    },

    update(taskId: string, task: Task): void {
      if (!tasks.has(taskId)) {
        throw new Error(`Task not registered: ${taskId}`);
      }
      tasks.set(taskId, task);
    },

    listByStatus(status: TaskStatus): Task[] {
      const result: Task[] = [];
      for (const task of tasks.values()) {
        if (task.status === status) {
          result.push(task);
        }
      }
      return result;
    },

    markNotified(taskId: string): void {
      if (!tasks.has(taskId)) {
        throw new Error(`Task not registered: ${taskId}`);
      }
      notifiedAt.set(taskId, Date.now());
    },

    evictNotified(graceMs: number = DEFAULT_GRACE_MS): string[] {
      const now = Date.now();
      const evicted: string[] = [];
      for (const [taskId, timestamp] of notifiedAt.entries()) {
        if (now - timestamp >= graceMs) {
          tasks.delete(taskId);
          notifiedAt.delete(taskId);
          evicted.push(taskId);
        }
      }
      return evicted;
    },

    get size(): number {
      return tasks.size;
    },
  };
}
