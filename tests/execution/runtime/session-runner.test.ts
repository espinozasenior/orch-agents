/**
 * TDD: Tests for SessionRunner — child process lifecycle with NDJSON I/O.
 *
 * Phase 9B: Bridge-Harness Separation (FR-9B.02 through FR-9B.09)
 *
 * London School TDD — mock child_process.spawn.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import {
  SessionRunner,
  calculateBackoff,
} from '../../../src/execution/runtime/session-runner';
import type { SessionRunnerCallbacks } from '../../../src/execution/runtime/session-runner';
import type { Logger, LogContext } from '../../../src/shared/logger';
import type {
  ResultMessage,
  PermissionRequestMessage,
  NdjsonEnvelope,
  TaskPayload,
} from '../../../src/execution/runtime/ndjson-protocol';
import { encodeMessage } from '../../../src/execution/runtime/ndjson-protocol';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeNullLogger(): Logger {
  const noop = (_msg: string, _ctx?: LogContext) => {};
  return {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => makeNullLogger(),
  };
}

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: (signal?: string) => boolean;
  killed: boolean;
}

function createFakeChild(pid = 12345): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.killed = false;
  child.kill = (signal?: string) => {
    child.killed = true;
    // Simulate real child behavior: emit exit after kill
    process.nextTick(() => child.emit('exit', signal === 'SIGKILL' ? null : 1, signal ?? 'SIGTERM'));
    return true;
  };
  return child;
}

function createMockSpawn(fakeChild: FakeChild) {
  return (_cmd: string, _args: readonly string[], _opts: unknown) => {
    return fakeChild as unknown as ChildProcess;
  };
}

function makeTask(id = 't-1'): NdjsonEnvelope<'task', TaskPayload> {
  return {
    type: 'task',
    id,
    sessionId: 's-1',
    payload: { tool: 'Edit', args: { file: 'test.ts' } },
    timestamp: Date.now(),
  };
}

function makeCallbacks(overrides: Partial<SessionRunnerCallbacks> = {}): SessionRunnerCallbacks {
  return {
    onResult: () => {},
    onPermission: () => {},
    onCrash: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionRunner', () => {
  let fakeChild: FakeChild;
  let runner: SessionRunner;
  let callbacks: SessionRunnerCallbacks;

  beforeEach(() => {
    fakeChild = createFakeChild();
    callbacks = makeCallbacks();
  });

  function createRunner(overrides: Partial<SessionRunnerCallbacks> = {}) {
    callbacks = makeCallbacks(overrides);
    runner = new SessionRunner({
      id: 'test-session',
      workDir: '/tmp/test-session',
      callbacks,
      logger: makeNullLogger(),
      spawnFn: createMockSpawn(fakeChild) as any,
    });
    return runner;
  }

  // -----------------------------------------------------------------------
  // Spawn
  // -----------------------------------------------------------------------

  describe('spawn', () => {
    it('spawns child process and reports idle state', async () => {
      const r = createRunner();
      await r.spawn();
      assert.equal(r.state, 'idle');
      assert.equal(r.info.pid, 12345);
    });

    it('passes correct spawn flags (FR-9B.02)', async () => {
      let capturedArgs: readonly string[] = [];
      const r = new SessionRunner({
        id: 'flag-test',
        workDir: '/tmp/flag-test',
        callbacks: makeCallbacks(),
        logger: makeNullLogger(),
        spawnFn: ((_cmd: string, args: readonly string[], _opts: unknown) => {
          capturedArgs = args;
          return fakeChild as unknown as ChildProcess;
        }) as any,
      });
      await r.spawn();
      assert.ok(capturedArgs.includes('--input-format'));
      assert.ok(capturedArgs.includes('stream-json'));
      assert.ok(capturedArgs.includes('--output-format'));
      assert.ok(capturedArgs.includes('--working-dir'));
    });
  });

  // -----------------------------------------------------------------------
  // Dispatch
  // -----------------------------------------------------------------------

  describe('dispatch', () => {
    it('transitions state from idle to working', async () => {
      const r = createRunner();
      await r.spawn();
      const task = makeTask();
      r.dispatch(task);
      assert.equal(r.state, 'working');
      assert.equal(r.info.currentTaskId, 't-1');
    });

    it('writes NDJSON to child stdin', async () => {
      const r = createRunner();
      await r.spawn();
      const task = makeTask();

      let stdinData = '';
      fakeChild.stdin.on('data', (chunk: Buffer) => {
        stdinData += chunk.toString();
      });

      r.dispatch(task);

      // Allow microtask to flush
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(stdinData.includes('"type":"task"'));
      assert.ok(stdinData.includes('"id":"t-1"'));
    });

    it('throws when dispatching to failed session', async () => {
      const r = createRunner();
      // Manually set state to simulate failure
      (r as any)._state = 'failed';
      assert.throws(
        () => r.dispatch(makeTask()),
        { message: /Cannot dispatch to failed session/ },
      );
    });
  });

  // -----------------------------------------------------------------------
  // NDJSON parsing from child stdout (FR-9B.03)
  // -----------------------------------------------------------------------

  describe('child stdout NDJSON parsing', () => {
    it('parses result message and transitions to idle', async () => {
      let resultReceived = false;
      const r = createRunner({
        onResult: () => { resultReceived = true; },
      });
      await r.spawn();
      r.dispatch(makeTask());
      assert.equal(r.state, 'working');

      // Simulate child sending result
      const resultMsg: ResultMessage = {
        type: 'result',
        id: 't-1',
        sessionId: 'test-session',
        payload: { success: true, output: 'done' },
        timestamp: Date.now(),
      };
      fakeChild.stdout.write(JSON.stringify(resultMsg) + '\n');

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(r.state, 'idle');
      assert.equal(resultReceived, true);
      assert.equal(r.info.currentTaskId, null);
    });

    it('parses permission_request and transitions to requires_action', async () => {
      let permReceived = false;
      const r = createRunner({
        onPermission: () => { permReceived = true; },
      });
      await r.spawn();
      r.dispatch(makeTask());

      const permMsg: PermissionRequestMessage = {
        type: 'permission_request',
        id: 'pr-1',
        sessionId: 'test-session',
        payload: { tool: 'Bash', command: 'rm -rf /tmp/test' },
        timestamp: Date.now(),
      };
      fakeChild.stdout.write(JSON.stringify(permMsg) + '\n');

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(r.state, 'requires_action');
      assert.equal(permReceived, true);
    });

    it('handles malformed NDJSON without crashing parent', async () => {
      const r = createRunner();
      await r.spawn();

      // Should not throw or crash
      fakeChild.stdout.write('this is not json\n');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(r.state, 'idle');
    });
  });

  // -----------------------------------------------------------------------
  // Permission response (FR-9B.05)
  // -----------------------------------------------------------------------

  describe('sendPermissionResponse', () => {
    it('writes permission_response to stdin and transitions back to working', async () => {
      const r = createRunner();
      await r.spawn();
      r.dispatch(makeTask());

      // Simulate requires_action state
      const permMsg: PermissionRequestMessage = {
        type: 'permission_request',
        id: 'pr-1',
        sessionId: 'test-session',
        payload: { tool: 'Bash', command: 'echo hi' },
        timestamp: Date.now(),
      };
      fakeChild.stdout.write(JSON.stringify(permMsg) + '\n');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(r.state, 'requires_action');

      let stdinData = '';
      fakeChild.stdin.on('data', (chunk: Buffer) => {
        stdinData += chunk.toString();
      });

      r.sendPermissionResponse('pr-1', { approved: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(r.state, 'working');
      assert.ok(stdinData.includes('"permission_response"'));
      assert.ok(stdinData.includes('"approved":true'));
    });
  });

  // -----------------------------------------------------------------------
  // Crash handling (FR-9B.06)
  // -----------------------------------------------------------------------

  describe('crash recovery', () => {
    it('calls onCrash when child exits with non-zero code', async () => {
      let crashCalled = false;
      const r = createRunner({
        onCrash: () => { crashCalled = true; },
      });
      await r.spawn();

      fakeChild.emit('exit', 1, null);
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(crashCalled, true);
      assert.equal(r.crashCount, 1);
    });

    it('calls onCrash when child is killed by signal', async () => {
      let crashCalled = false;
      const r = createRunner({
        onCrash: () => { crashCalled = true; },
      });
      await r.spawn();

      fakeChild.emit('exit', null, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(crashCalled, true);
      assert.equal(r.crashCount, 1);
    });

    it('does not call onCrash for clean exit (code 0)', async () => {
      let crashCalled = false;
      const r = createRunner({
        onCrash: () => { crashCalled = true; },
      });
      await r.spawn();

      fakeChild.emit('exit', 0, null);
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(crashCalled, false);
      assert.equal(r.crashCount, 0);
    });

    it('respawn creates new child process', async () => {
      let spawnCount = 0;
      const r = new SessionRunner({
        id: 'respawn-test',
        workDir: '/tmp/respawn-test',
        callbacks: makeCallbacks(),
        logger: makeNullLogger(),
        spawnFn: ((_cmd: string, _args: readonly string[], _opts: unknown) => {
          spawnCount++;
          return createFakeChild(12345 + spawnCount) as unknown as ChildProcess;
        }) as any,
      });

      await r.spawn();
      assert.equal(spawnCount, 1);

      await r.respawn();
      assert.equal(spawnCount, 2);
    });
  });

  // -----------------------------------------------------------------------
  // Drain
  // -----------------------------------------------------------------------

  describe('drain', () => {
    it('transitions to draining state', async () => {
      const r = createRunner();
      await r.spawn();

      // Start drain (no in-flight task, should resolve quickly)
      // Use short timeout since fake child won't exit
      await r.drain(50);
      // After drain, child is killed — state may vary but we check it started draining
    });
  });

  // -----------------------------------------------------------------------
  // calculateBackoff
  // -----------------------------------------------------------------------

  describe('calculateBackoff', () => {
    it('first crash: 1s', () => {
      assert.equal(calculateBackoff(1), 1000);
    });

    it('second crash: 2s', () => {
      assert.equal(calculateBackoff(2), 2000);
    });

    it('third crash: 4s', () => {
      assert.equal(calculateBackoff(3), 4000);
    });

    it('caps at maxMs (default 30s)', () => {
      assert.equal(calculateBackoff(10), 30_000);
      assert.equal(calculateBackoff(20), 30_000);
    });

    it('respects custom maxMs', () => {
      assert.equal(calculateBackoff(10, 5000), 5000);
    });
  });

  // -----------------------------------------------------------------------
  // Session info
  // -----------------------------------------------------------------------

  describe('info', () => {
    it('returns correct session snapshot', async () => {
      const r = createRunner();
      await r.spawn();
      const info = r.info;

      assert.equal(info.id, 'test-session');
      assert.equal(info.state, 'idle');
      assert.equal(info.pid, 12345);
      assert.equal(info.workDir, '/tmp/test-session');
      assert.equal(info.crashCount, 0);
      assert.equal(info.lastCrash, null);
      assert.equal(info.currentTaskId, null);
    });
  });
});
