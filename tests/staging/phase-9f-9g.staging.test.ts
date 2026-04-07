/**
 * Phase 9F + 9G: Task Taxonomy & Deferred Tool Loading — Staging Tests
 *
 * Validates implementations against:
 *   docs/sparc/phase-9f-task-type-taxonomy.md
 *   docs/sparc/phase-9g-deferred-tool-loading.md
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Phase 9F — Task Type Taxonomy
import {
  TaskType,
  TaskStatus,
  TASK_TYPE_METADATA,
  TASK_TYPE_PREFIX,
  PREFIX_TO_TASK_TYPE,
  createTaskId,
  parseTaskType,
  createTask,
  transition,
  InvalidTransitionError,
  createTaskRouter,
  type Task,
} from '../../src/execution/task/index';

// Phase 9G — Deferred Tool Loading: removed in P12 spec revision (replaced by
// src/services/deferred-tools/* — see docs/sparc/P12-deferred-tool-loading-spec.md).

// ===================================================================
// Phase 9F: Task Type Taxonomy
// ===================================================================

describe('9F Staging: FR-9F.01 — Task ID format', () => {
  it('local_bash task ID matches pattern lb-[a-f0-9]{32}', () => {
    const id = createTaskId(TaskType.local_bash);
    assert.match(id, /^lb-[a-f0-9]{32}$/, `Got: ${id}`);
  });

  it('all 7 task types produce correctly-prefixed IDs', () => {
    const types = [
      TaskType.local_bash, TaskType.local_agent, TaskType.remote_agent,
      TaskType.in_process_teammate, TaskType.local_workflow,
      TaskType.monitor_mcp, TaskType.dream,
    ];

    for (const type of types) {
      const id = createTaskId(type);
      const prefix = TASK_TYPE_PREFIX[type];
      assert.ok(id.startsWith(`${prefix}-`), `${type} → prefix ${prefix}`);
      assert.equal(id.length, prefix.length + 1 + 32, `${type} → 32 hex chars`);
    }
  });
});

describe('9F Staging: FR-9F.02 — Type extraction from ID', () => {
  it('parseTaskType round-trips for all types', () => {
    for (const type of Object.values(TaskType)) {
      const id = createTaskId(type);
      const parsed = parseTaskType(id);
      assert.equal(parsed, type, `Round-trip for ${type}`);
    }
  });

  it('parseTaskType returns undefined for invalid prefix', () => {
    assert.equal(parseTaskType('xx-abcdef1234567890abcdef1234567890'), undefined);
  });
});

describe('9F Staging: FR-9F.03 — State machine transitions', () => {
  let task: Task;

  beforeEach(() => {
    task = createTask(TaskType.local_bash);
  });

  it('valid: pending → running → completed', () => {
    const running = transition(task, TaskStatus.running);
    assert.equal(running.status, TaskStatus.running);

    const completed = transition(running, TaskStatus.completed);
    assert.equal(completed.status, TaskStatus.completed);
  });

  it('valid: pending → cancelled', () => {
    const cancelled = transition(task, TaskStatus.cancelled);
    assert.equal(cancelled.status, TaskStatus.cancelled);
  });

  it('valid: running → failed', () => {
    const running = transition(task, TaskStatus.running);
    const failed = transition(running, TaskStatus.failed);
    assert.equal(failed.status, TaskStatus.failed);
  });

  it('invalid: completed → running throws InvalidTransitionError', () => {
    const running = transition(task, TaskStatus.running);
    const completed = transition(running, TaskStatus.completed);

    assert.throws(
      () => transition(completed, TaskStatus.running),
      InvalidTransitionError,
      'Cannot go from completed to running',
    );
  });

  it('invalid: pending → completed throws', () => {
    assert.throws(
      () => transition(task, TaskStatus.completed),
      InvalidTransitionError,
    );
  });

  it('immutability: transition returns new object', () => {
    const running = transition(task, TaskStatus.running);
    assert.notEqual(running, task, 'Different object reference');
    assert.equal(task.status, TaskStatus.pending, 'Original unchanged');
  });
});

describe('9F Staging: FR-9F.04 — Task metadata defaults', () => {
  it('each type has metadata with required fields', () => {
    for (const type of Object.values(TaskType)) {
      const meta = TASK_TYPE_METADATA[type];
      assert.ok(meta, `Metadata exists for ${type}`);
      assert.ok(meta.defaultTimeout > 0 || meta.defaultTimeout === Infinity, `${type} has timeout`);
      assert.ok(typeof meta.maxRetries === 'number', `${type} has maxRetries`);
      assert.ok(meta.concurrencyClass, `${type} has concurrencyClass`);
    }
  });

  it('DREAM has lowest priority (highest number)', () => {
    const dreamPriority = TASK_TYPE_METADATA[TaskType.dream].priority;
    for (const type of Object.values(TaskType)) {
      if (type !== TaskType.dream) {
        assert.ok(
          TASK_TYPE_METADATA[type].priority <= dreamPriority,
          `${type} priority ≤ DREAM priority`,
        );
      }
    }
  });

  it('MONITOR_MCP has infinite retries', () => {
    const meta = TASK_TYPE_METADATA[TaskType.monitor_mcp];
    assert.equal(meta.maxRetries, Infinity, 'Monitor auto-restarts');
  });
});

describe('9F Staging: FR-9F.05 — Task router', () => {
  it('dispatches to correct executor by type', async () => {
    const dispatched: TaskType[] = [];
    const executors = new Map([
      [TaskType.local_bash, {
        execute: async (t: Task) => { dispatched.push(t.type); return { status: 'completed' as const }; },
      }],
    ]);

    const router = createTaskRouter(executors);
    const task = createTask(TaskType.local_bash);
    await router.dispatch(task);

    assert.deepEqual(dispatched, [TaskType.local_bash]);
  });
});

