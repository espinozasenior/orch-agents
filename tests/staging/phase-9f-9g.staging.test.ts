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

// Phase 9G — Deferred Tool Loading
import {
  DeferredToolRegistry,
  ToolSearchIndex,
  LazyToolProxy,
  DiskResultCache,
  type DeferredToolDefinition,
  type ToolSearchQuery,
} from '../../src/services/tools/deferredIndex';

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

// ===================================================================
// Phase 9G: Deferred Tool Loading
// ===================================================================

describe('9G Staging: FR-9G.01 — Deferred tool registry', () => {
  it('registers deferred tools without loading schema', () => {
    const registry = new DeferredToolRegistry();
    const def: DeferredToolDefinition = {
      name: 'Read',
      shouldDefer: true,
      concurrencySafe: true,
      interruptBehavior: 'cancel',
      persistResultToDisk: false,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: 'test' }),
    };

    registry.register('Read', def);
    assert.ok(registry.shouldDefer('Read'), 'Read is deferred');
    assert.ok(registry.listDeferred().includes('Read'), 'Read in deferred list');
  });

  it('resolve returns full definition on demand', () => {
    const registry = new DeferredToolRegistry();
    registry.register('Read', {
      name: 'Read',
      shouldDefer: false,
      concurrencySafe: true,
      interruptBehavior: 'cancel',
      persistResultToDisk: false,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: 'file' }),
    });

    const resolved = registry.resolve('Read');
    assert.equal(resolved.name, 'Read');
  });

  it('batch resolve returns all requested tools', () => {
    const registry = new DeferredToolRegistry();
    for (const name of ['Read', 'Write', 'Edit']) {
      registry.register(name, {
        name,
        shouldDefer: false,
        concurrencySafe: name === 'Read',
        interruptBehavior: 'cancel',
        persistResultToDisk: false,
        isConcurrencySafe: () => name === 'Read',
        execute: async () => ({ content: name }),
      });
    }

    const resolved = registry.resolveMany(['Read', 'Write', 'Edit']);
    assert.equal(resolved.length, 3);
  });

  it('metrics track deferred vs eager', () => {
    const registry = new DeferredToolRegistry();
    registry.register('A', {
      name: 'A', shouldDefer: true, concurrencySafe: true,
      interruptBehavior: 'cancel', persistResultToDisk: false,
      isConcurrencySafe: () => true, execute: async () => ({ content: '' }),
    });
    registry.register('B', {
      name: 'B', shouldDefer: false, concurrencySafe: true,
      interruptBehavior: 'cancel', persistResultToDisk: false,
      isConcurrencySafe: () => true, execute: async () => ({ content: '' }),
    });

    const metrics = registry.getMetrics();
    assert.ok(metrics.deferredCount >= 1, 'Has deferred');
    assert.ok(metrics.eagerCount >= 1, 'Has eager');
  });
});

describe('9G Staging: FR-9G.02 — Tool search index', () => {
  let index: ToolSearchIndex;

  beforeEach(() => {
    index = new ToolSearchIndex();
    for (const name of ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'WebSearch']) {
      index.add({
        name,
        shouldDefer: true,
        concurrencySafe: ['Read', 'Grep', 'Glob', 'WebSearch'].includes(name),
        interruptBehavior: 'cancel',
        persistResultToDisk: false,
        description: `The ${name} tool`,
        isConcurrencySafe: () => ['Read', 'Grep', 'Glob', 'WebSearch'].includes(name),
        execute: async () => ({ content: '' }),
      });
    }
  });

  it('select mode: exact name match', () => {
    const query = index.parseQuery('select:Read,Edit');
    const results = index.search(query);
    assert.equal(results.length, 2);
    const names = results.map(r => r.name).sort();
    assert.deepEqual(names, ['Edit', 'Read']);
  });

  it('keyword mode: ranked by relevance', () => {
    const query = index.parseQuery('file read');
    const results = index.search(query);
    assert.ok(results.length > 0, 'Has keyword results');
  });

  it('required mode: keyword must be in name', () => {
    const query = index.parseQuery('+Read search');
    const results = index.search(query);
    assert.ok(results.every(r => r.name.toLowerCase().includes('read')),
      'All results have "Read" in name');
  });

  it('search is case-insensitive', () => {
    const query = index.parseQuery('select:read,EDIT');
    const results = index.search(query);
    assert.equal(results.length, 2);
  });
});

describe('9G Staging: FR-9G.03 — Lazy tool proxy', () => {
  it('proxy resolves on first execute', async () => {
    const registry = new DeferredToolRegistry();
    const def: DeferredToolDefinition = {
      name: 'TestTool',
      shouldDefer: false,
      concurrencySafe: true,
      interruptBehavior: 'cancel',
      persistResultToDisk: false,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: 'proxy-result' }),
    };
    registry.register('TestTool', def);

    // Constructor takes (def, registry)
    const proxy = new LazyToolProxy(def, registry);
    assert.equal(proxy.isResolved(), false, 'Not resolved initially');

    const result = await proxy.execute({});
    assert.equal(result.content, 'proxy-result');
    assert.equal(proxy.isResolved(), true, 'Resolved after execute');
  });
});

describe('9G Staging: FR-9G.04 — Disk result cache', () => {
  it('shouldSpill returns false for small results', () => {
    const cache = new DiskResultCache();
    assert.equal(cache.shouldSpill({ content: 'small' }), false);
  });

  it('shouldSpill returns true for results > 1MB', () => {
    const cache = new DiskResultCache();
    assert.equal(cache.shouldSpill({ content: 'x'.repeat(1_100_000) }), true);
  });

  it('spill/retrieve round-trips', () => {
    const cache = new DiskResultCache();
    const bigContent = 'y'.repeat(1_100_000);
    const ref = cache.spill('tool-123', { content: bigContent });

    assert.ok(ref.path, 'Has file path');
    assert.ok(ref.size > 0, 'Has size');

    const retrieved = cache.retrieve(ref);
    assert.equal(retrieved.content, bigContent, 'Content preserved');

    cache.cleanup();
  });
});
