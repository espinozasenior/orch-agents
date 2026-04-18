/**
 * P6 -- Task Poller: single poll cycle for running/terminal task monitoring.
 *
 * Reads output deltas for running tasks, marks terminal tasks as notified,
 * and evicts stale notified tasks (cleaning up their output files).
 *
 * Designed to be called on a ~1s interval by the orchestrator tick.
 */

import { TaskStatus } from './types';
import type { TaskRegistry } from './taskRegistry';
import type { TaskOutputWriter } from './taskOutputWriter';
import type { EventBus } from '../../kernel/event-bus';
import { createDomainEvent } from '../../kernel/event-bus';

// ---------------------------------------------------------------------------
// Per-task read offset tracking (in-memory, keyed by taskId)
// ---------------------------------------------------------------------------

const readOffsets = new Map<string, number>();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PollTasksOpts {
  graceMs?: number;
}

export interface PollTasksResult {
  running: number;
  notified: number;
  evicted: number;
}

// ---------------------------------------------------------------------------
// Terminal statuses
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: readonly TaskStatus[] = [
  TaskStatus.completed,
  TaskStatus.failed,
  TaskStatus.cancelled,
];

// ---------------------------------------------------------------------------
// Poll cycle
// ---------------------------------------------------------------------------

/**
 * Execute a single poll cycle:
 * 1. Read output deltas for running tasks, emit TaskOutputDelta events.
 * 2. Mark unnotified terminal tasks as notified, emit TaskNotified events.
 * 3. Evict stale notified tasks and clean up their output files.
 */
export function pollTasks(
  registry: TaskRegistry,
  outputWriter: TaskOutputWriter,
  eventBus: EventBus,
  opts: PollTasksOpts = {},
): PollTasksResult {
  const graceMs = opts.graceMs ?? 30_000;
  let notifiedCount = 0;

  // 1. Running tasks: read deltas
  const running = registry.listByStatus(TaskStatus.running);
  for (const task of running) {
    const offset = readOffsets.get(task.id) ?? 0;
    const delta = outputWriter.getDelta(task.id, offset);
    if (delta.data.length > 0) {
      readOffsets.set(task.id, delta.newOffset);
      eventBus.publish(createDomainEvent('TaskOutputDelta' as never, {
        taskId: task.id,
        delta: delta.data,
        offset: delta.newOffset,
      } as never));
    }
  }

  // 2. Terminal tasks: mark notified
  for (const status of TERMINAL_STATUSES) {
    const tasks = registry.listByStatus(status);
    for (const task of tasks) {
      try {
        registry.markNotified(task.id);
        notifiedCount++;
        eventBus.publish(createDomainEvent('TaskNotified' as never, {
          taskId: task.id,
          status: task.status,
        } as never));
      } catch {
        // Already notified (markNotified is idempotent in our design
        // but may throw if task was evicted concurrently)
      }
    }
  }

  // 3. Evict stale notified tasks
  const evictedIds = registry.evictNotified(graceMs);
  for (const taskId of evictedIds) {
    outputWriter.cleanup(taskId);
    readOffsets.delete(taskId);
  }

  return {
    running: running.length,
    notified: notifiedCount,
    evicted: evictedIds.length,
  };
}
