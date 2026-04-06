/**
 * Phase 9F -- Task factory: ID generation and task creation.
 */

import { randomBytes } from 'node:crypto';
import {
  TaskType,
  TaskStatus,
  TASK_TYPE_PREFIX,
  TASK_TYPE_METADATA,
  PREFIX_TO_TASK_TYPE,
  type Task,
  type TaskTypeMetadata,
} from './types';

/**
 * Generate a type-prefixed task ID.
 * Format: `{prefix}-{32 hex chars}` (16 random bytes = 128 bits).
 */
export function createTaskId(type: TaskType): string {
  const prefix = TASK_TYPE_PREFIX[type];
  const hex = randomBytes(16).toString('hex');
  return `${prefix}-${hex}`;
}

/**
 * Extract TaskType from a task ID prefix.
 * O(1) -- splits on first '-' then looks up in PREFIX_TO_TASK_TYPE.
 * Returns undefined for unknown prefixes.
 */
export function parseTaskType(id: string): TaskType | undefined {
  const dashIdx = id.indexOf('-');
  if (dashIdx === -1) return undefined;
  const prefix = id.slice(0, dashIdx);
  return PREFIX_TO_TASK_TYPE[prefix];
}

/**
 * Create a new Task in pending state with generated ID and merged metadata.
 */
export function createTask(
  type: TaskType,
  overrides?: Partial<TaskTypeMetadata>,
): Task {
  const now = Date.now();
  const baseMeta = TASK_TYPE_METADATA[type];
  const metadata: TaskTypeMetadata = overrides
    ? { ...baseMeta, ...overrides }
    : { ...baseMeta };

  return {
    id: createTaskId(type),
    type,
    status: TaskStatus.pending,
    metadata,
    createdAt: now,
    updatedAt: now,
  };
}
