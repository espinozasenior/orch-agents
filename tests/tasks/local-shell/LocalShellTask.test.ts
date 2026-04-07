/**
 * P13 — LocalShellTask executor: lifecycle, streaming, kill escalation.
 *
 * Mock-first per project conventions. We never actually spawn a real
 * subprocess in this file — `spawnFn` is injected and we drive a fake
 * `ChildProcess` via EventEmitters.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLocalShellTaskExecutor,
  type LocalShellTaskDeps,
  type ShellTaskPayload,
} from '../../../src/tasks/local-shell/LocalShellTask';
import { createTask } from '../../../src/execution/task/taskFactory';
import { TaskStatus, TaskType, type Task } from '../../../src/execution/task/types';
import { createTaskRegistry } from '../../../src/execution/task/taskRegistry';
import type { TaskOutputWriter } from '../../../src/execution/task';
import type { Logger } from '../../../src/shared/logger';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'p13-exec-'));
}

function silentLogger(): Logger {
  const noop = (): void => {};
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => silentLogger(),
  };
}

interface CapturedRecord {
  taskId: string;
  data: Record<string, unknown>;
}

function memoryWriter(): { writer: TaskOutputWriter; records: CapturedRecord[] } {
  const records: CapturedRecord[] = [];
  const writer: TaskOutputWriter = {
    append(taskId, data) {
      records.push({ taskId, data });
    },
    getDelta() {
      return { data: '', newOffset: 0 };
    },
    cleanup() {},
    getOutputPath(taskId) {
      return `/tmp/${taskId}.jsonl`;
    },
  };
  return { writer, records };
}

class FakeChildProcess extends EventEmitter {
  pid = 12345;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  killCalls: NodeJS.Signals[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push((signal ?? 'SIGTERM') as NodeJS.Signals);
    this.killed = true;
    return true;
  }
}

interface SpawnSpy {
  fn: NonNullable<LocalShellTaskDeps['spawnFn']>;
  child: FakeChildProcess;
  calls: Array<{ command: string; args: string[]; opts: unknown }>;
}

function spawnSpy(): SpawnSpy {
  const child = new FakeChildProcess();
  const calls: SpawnSpy['calls'] = [];
  const fn = ((command: string, args: readonly string[], opts: unknown) => {
    calls.push({ command, args: [...args], opts });
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as NonNullable<LocalShellTaskDeps['spawnFn']>;
  return { fn, child, calls };
}

function makeDeps(overrides: Partial<LocalShellTaskDeps> = {}): {
  deps: LocalShellTaskDeps;
  records: CapturedRecord[];
  spawn: SpawnSpy;
  root: string;
  cleanup: () => void;
} {
  const root = makeTmp();
  const { writer, records } = memoryWriter();
  const spawn = spawnSpy();
  const deps: LocalShellTaskDeps = {
    taskOutputWriter: writer,
    logger: silentLogger(),
    allowedRoots: [root],
    spawnFn: spawn.fn,
    killGraceMs: 50,
    ...overrides,
  };
  return {
    deps,
    records,
    spawn,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function newPendingTask(): Task {
  return createTask(TaskType.local_bash);
}

function payloadFor(cwd: string, overrides: Partial<ShellTaskPayload> = {}): ShellTaskPayload {
  return {
    command: '/bin/echo',
    args: ['hello'],
    cwd,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalShellTask — happy path', () => {
  it('exit code 0 → completed', async () => {
    const { deps, spawn, root, cleanup } = makeDeps();
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, payloadFor(root));
      // Drive the fake child to a clean exit on the next tick.
      setImmediate(() => spawn.child.emit('exit', 0, null));
      const result = await promise;
      assert.equal(result.status, 'completed');
      assert.equal(result.exitCode, 0);
      assert.equal(result.signal, null);
      assert.equal(result.pid, 12345);
      assert.ok(result.durationMs >= 0);
    } finally {
      cleanup();
    }
  });

  it('passes command, args, cwd, and shell:false to spawn', async () => {
    const { deps, spawn, root, cleanup } = makeDeps();
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, {
        command: '/usr/bin/git',
        args: ['status', '--porcelain'],
        cwd: root,
      });
      setImmediate(() => spawn.child.emit('exit', 0, null));
      await promise;
      assert.equal(spawn.calls.length, 1);
      assert.equal(spawn.calls[0]!.command, '/usr/bin/git');
      assert.deepEqual(spawn.calls[0]!.args, ['status', '--porcelain']);
      const opts = spawn.calls[0]!.opts as Record<string, unknown>;
      assert.equal(opts.shell, false);
      assert.equal(opts.cwd, root);
      assert.equal(opts.detached, false);
      assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
    } finally {
      cleanup();
    }
  });
});

describe('LocalShellTask — output streaming', () => {
  it('appends stdout chunks as JSONL records', async () => {
    const { deps, spawn, records, root, cleanup } = makeDeps();
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, payloadFor(root));
      setImmediate(() => {
        spawn.child.stdout.emit('data', Buffer.from('hello\n'));
        spawn.child.stdout.emit('data', Buffer.from('world\n'));
        spawn.child.emit('exit', 0, null);
      });
      const result = await promise;
      assert.equal(result.status, 'completed');
      const stdoutRecords = records.filter((r) => r.data.stream === 'stdout');
      assert.equal(stdoutRecords.length, 2);
      assert.equal(stdoutRecords[0]!.data.data, 'hello\n');
      assert.equal(stdoutRecords[1]!.data.data, 'world\n');
      assert.equal(result.outputBytes, 12);
    } finally {
      cleanup();
    }
  });

  it('appends stderr chunks distinctly from stdout', async () => {
    const { deps, spawn, records, root, cleanup } = makeDeps();
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, payloadFor(root));
      setImmediate(() => {
        spawn.child.stderr.emit('data', Buffer.from('boom'));
        spawn.child.emit('exit', 0, null);
      });
      await promise;
      const stderrRecords = records.filter((r) => r.data.stream === 'stderr');
      assert.equal(stderrRecords.length, 1);
      assert.equal(stderrRecords[0]!.data.data, 'boom');
    } finally {
      cleanup();
    }
  });

  it('truncates output past maxOutputBytes', async () => {
    const { deps, spawn, records, root, cleanup } = makeDeps({ maxOutputBytes: 10 });
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, payloadFor(root));
      setImmediate(() => {
        spawn.child.stdout.emit('data', Buffer.from('0123456789ABCDEF')); // 16 bytes
        spawn.child.stdout.emit('data', Buffer.from('extra'));
        spawn.child.emit('exit', 0, null);
      });
      const result = await promise;
      assert.equal(result.outputBytes, 10);
      const stdoutRecords = records.filter((r) => r.data.stream === 'stdout');
      assert.equal(stdoutRecords.length, 1);
      assert.equal(stdoutRecords[0]!.data.data, '0123456789');
      const truncationNotice = records.find(
        (r) => typeof r.data.data === 'string' && (r.data.data as string).includes('truncated'),
      );
      assert.ok(truncationNotice, 'truncation notice should be appended');
    } finally {
      cleanup();
    }
  });
});

describe('LocalShellTask — exit code mapping', () => {
  it('exit code 7 → failed with exitCode=7', async () => {
    const { deps, spawn, root, cleanup } = makeDeps();
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, payloadFor(root));
      setImmediate(() => spawn.child.emit('exit', 7, null));
      const result = await promise;
      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 7);
      assert.equal(result.reason, 'exit-nonzero');
    } finally {
      cleanup();
    }
  });

  it('external SIGTERM (no killSource) → killed with reason=killed-by-signal', async () => {
    const { deps, spawn, root, cleanup } = makeDeps();
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, payloadFor(root));
      setImmediate(() => spawn.child.emit('exit', null, 'SIGTERM' as NodeJS.Signals));
      const result = await promise;
      assert.equal(result.status, 'killed');
      assert.equal(result.signal, 'SIGTERM');
      assert.equal(result.reason, 'killed-by-signal');
    } finally {
      cleanup();
    }
  });
});

describe('LocalShellTask — spawn failure', () => {
  it('async ENOENT → failed with reason=spawn-error', async () => {
    const { deps, spawn, root, cleanup } = makeDeps();
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, payloadFor(root, { command: '/no/such/bin' }));
      setImmediate(() => {
        const err = new Error('spawn /no/such/bin ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        spawn.child.emit('error', err);
      });
      const result = await promise;
      assert.equal(result.status, 'failed');
      assert.equal(result.reason, 'spawn-error');
      assert.equal(result.exitCode, null);
    } finally {
      cleanup();
    }
  });

  it('synchronous spawn throw → failed with reason=spawn-error', async () => {
    const { root, cleanup } = makeDeps();
    try {
      const { writer } = memoryWriter();
      const throwingSpawn = (() => {
        throw new Error('cannot spawn');
      }) as NonNullable<LocalShellTaskDeps['spawnFn']>;
      const exec = createLocalShellTaskExecutor({
        taskOutputWriter: writer,
        logger: silentLogger(),
        allowedRoots: [root],
        spawnFn: throwingSpawn,
      });
      const task = newPendingTask();
      const result = await exec.execute(task, payloadFor(root));
      assert.equal(result.status, 'failed');
      assert.equal(result.reason, 'spawn-error');
      // pending → cancelled (no running transition)
      assert.equal(task.status, TaskStatus.pending);
    } finally {
      cleanup();
    }
  });
});

describe('LocalShellTask — timeout & kill escalation', () => {
  it('timeout sends SIGTERM, then SIGKILL after grace if no exit', async () => {
    const { deps, spawn, root, cleanup } = makeDeps({ killGraceMs: 30 });
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, payloadFor(root, { timeoutMs: 10 }));
      // Fake child never exits on its own — wait for SIGKILL path.
      setTimeout(() => {
        // After SIGTERM + grace, the executor will have called SIGKILL.
        // Emit exit with SIGKILL signal so the promise resolves.
        spawn.child.emit('exit', null, 'SIGKILL' as NodeJS.Signals);
      }, 60);
      const result = await promise;
      assert.equal(result.status, 'killed');
      assert.equal(result.killSource, 'timeout');
      assert.equal(result.reason, 'timeout');
      // SIGTERM must precede SIGKILL
      assert.ok(spawn.child.killCalls.length >= 1);
      assert.equal(spawn.child.killCalls[0], 'SIGTERM');
      assert.ok(spawn.child.killCalls.includes('SIGKILL'));
    } finally {
      cleanup();
    }
  });

  it('SIGTERM-graceful exit clears the SIGKILL timer', async () => {
    const { deps, spawn, root, cleanup } = makeDeps({ killGraceMs: 200 });
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, payloadFor(root, { timeoutMs: 10 }));
      // SIGTERM happens after 10ms; child exits cleanly after 30ms.
      setTimeout(() => spawn.child.emit('exit', null, 'SIGTERM' as NodeJS.Signals), 30);
      const result = await promise;
      assert.equal(result.status, 'killed');
      assert.equal(result.killSource, 'timeout');
      // Only SIGTERM should have been sent — SIGKILL never fires
      assert.equal(spawn.child.killCalls.length, 1);
      assert.equal(spawn.child.killCalls[0], 'SIGTERM');
    } finally {
      cleanup();
    }
  });
});

describe('LocalShellTask — security boundaries', () => {
  it('rejects cwd outside allowed roots — no spawn attempted', async () => {
    const { deps, spawn, root, cleanup } = makeDeps();
    try {
      const otherRoot = makeTmp();
      try {
        const exec = createLocalShellTaskExecutor(deps);
        const task = newPendingTask();
        const result = await exec.execute(task, payloadFor(otherRoot));
        assert.equal(result.status, 'failed');
        assert.equal(result.reason, 'cwd-not-allowed');
        assert.equal(spawn.calls.length, 0, 'spawn must not be called');
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    } finally {
      cleanup();
    }
  });

  it('strips secret env vars from spawned subprocess env', async () => {
    const { deps, spawn, root, cleanup } = makeDeps({
      envAllowlist: ['PATH', 'GITHUB_TOKEN'],
    });
    try {
      // Stash a fake secret on parent env temporarily.
      const prev = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_should_not_leak';
      try {
        const exec = createLocalShellTaskExecutor(deps);
        const task = newPendingTask();
        const promise = exec.execute(task, payloadFor(root));
        setImmediate(() => spawn.child.emit('exit', 0, null));
        await promise;
        const opts = spawn.calls[0]!.opts as { env: Record<string, string> };
        assert.equal(opts.env.GITHUB_TOKEN, undefined);
      } finally {
        if (prev === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = prev;
      }
    } finally {
      cleanup();
    }
  });

  it('does not inherit arbitrary parent env vars', async () => {
    const { deps, spawn, root, cleanup } = makeDeps({ envAllowlist: ['PATH'] });
    try {
      process.env.P13_TEST_RANDOM = 'should-not-leak';
      try {
        const exec = createLocalShellTaskExecutor(deps);
        const task = newPendingTask();
        const promise = exec.execute(task, payloadFor(root));
        setImmediate(() => spawn.child.emit('exit', 0, null));
        await promise;
        const opts = spawn.calls[0]!.opts as { env: Record<string, string> };
        assert.equal(opts.env.P13_TEST_RANDOM, undefined);
      } finally {
        delete process.env.P13_TEST_RANDOM;
      }
    } finally {
      cleanup();
    }
  });
});

describe('LocalShellTask — task lifecycle integration', () => {
  it('updates registry through pending → running → terminal', async () => {
    const { deps, spawn, root, cleanup } = makeDeps();
    try {
      const registry = createTaskRegistry();
      const exec = createLocalShellTaskExecutor({ ...deps, taskRegistry: registry });
      const task = newPendingTask();
      registry.register(task);
      const observed: TaskStatus[] = [];
      const promise = exec.execute(task, payloadFor(root));
      // After spawn we should have transitioned to running.
      setImmediate(() => {
        observed.push(registry.get(task.id)!.status);
        spawn.child.emit('exit', 0, null);
      });
      await promise;
      observed.push(registry.get(task.id)!.status);
      assert.equal(observed[0], TaskStatus.running);
      assert.equal(observed[1], TaskStatus.completed);
    } finally {
      cleanup();
    }
  });

  it('failed exit code reaches TaskStatus.failed in the registry', async () => {
    const { deps, spawn, root, cleanup } = makeDeps();
    try {
      const registry = createTaskRegistry();
      const exec = createLocalShellTaskExecutor({ ...deps, taskRegistry: registry });
      const task = newPendingTask();
      registry.register(task);
      const promise = exec.execute(task, payloadFor(root));
      setImmediate(() => spawn.child.emit('exit', 2, null));
      await promise;
      assert.equal(registry.get(task.id)!.status, TaskStatus.failed);
    } finally {
      cleanup();
    }
  });

  it('cwd-rejected task transitions pending → cancelled in the registry', async () => {
    const { deps, root, cleanup } = makeDeps();
    try {
      const otherRoot = makeTmp();
      try {
        const registry = createTaskRegistry();
        const exec = createLocalShellTaskExecutor({ ...deps, taskRegistry: registry });
        const task = newPendingTask();
        registry.register(task);
        const result = await exec.execute(task, payloadFor(otherRoot));
        assert.equal(result.status, 'failed');
        assert.equal(registry.get(task.id)!.status, TaskStatus.cancelled);
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    } finally {
      cleanup();
    }
  });

  it('works without a TaskRegistry (registry is optional)', async () => {
    const { deps, spawn, root, cleanup } = makeDeps();
    try {
      const exec = createLocalShellTaskExecutor(deps);
      const task = newPendingTask();
      const promise = exec.execute(task, payloadFor(root));
      setImmediate(() => spawn.child.emit('exit', 0, null));
      const result = await promise;
      assert.equal(result.status, 'completed');
    } finally {
      cleanup();
    }
  });
});

// Silence unused-import warnings if any.
void mock;
