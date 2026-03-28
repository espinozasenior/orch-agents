/**
 * TDD: Tests for InteractiveTaskExecutor — executes Claude in interactive mode
 * with tool access, scoped to a git worktree directory.
 *
 * London School TDD — mock the spawn function.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  createInteractiveExecutor,
  type InteractiveTaskExecutor,
  type InteractiveExecutionRequest,
  type InteractiveExecutorDeps,
} from '../../src/execution/runtime/interactive-executor';
import type { Logger, LogContext } from '../../src/shared/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  overrides: Partial<InteractiveExecutionRequest> = {},
): InteractiveExecutionRequest {
  return {
    prompt: 'Implement auth middleware in src/auth.ts',
    agentRole: 'implementer',
    agentType: 'coder',
    tier: 3,
    phaseType: 'refinement',
    timeout: 60_000,
    metadata: { planId: 'plan-001', workItemId: 'work-001' },
    worktreePath: '/tmp/orch-agents/plan-001',
    ...overrides,
  };
}

function makeSpyLogger(): Logger & { calls: { level: string; msg: string; ctx?: LogContext }[] } {
  const calls: { level: string; msg: string; ctx?: LogContext }[] = [];
  const spy: Logger & { calls: typeof calls } = {
    calls,
    trace: (msg: string, ctx?: LogContext) => calls.push({ level: 'trace', msg, ctx }),
    debug: (msg: string, ctx?: LogContext) => calls.push({ level: 'debug', msg, ctx }),
    info: (msg: string, ctx?: LogContext) => calls.push({ level: 'info', msg, ctx }),
    warn: (msg: string, ctx?: LogContext) => calls.push({ level: 'warn', msg, ctx }),
    error: (msg: string, ctx?: LogContext) => calls.push({ level: 'error', msg, ctx }),
    fatal: (msg: string, ctx?: LogContext) => calls.push({ level: 'fatal', msg, ctx }),
    child: () => spy,
  };
  return spy;
}

/**
 * Minimal mock stdout/stderr that uses EventEmitter 'data' events
 * directly — avoids Readable stream buffering issues.
 */
class MockStream extends EventEmitter {
  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

interface MockChildProcess extends EventEmitter {
  pid: number;
  stdin: Writable;
  stdout: MockStream;
  stderr: MockStream;
}

/**
 * Create a mock spawn function that records calls and returns a controllable
 * child process. Call `complete(exitCode, stdout, stderr)` to simulate the
 * process finishing.
 */
function createMockSpawn() {
  const calls: { bin: string; args: string[]; opts: Record<string, unknown> }[] = [];
  let stdinData = '';

  /** Promise resolved when stdin.end() is called */
  let stdinEndResolve: (() => void) | undefined;
  const stdinEnded = new Promise<void>((r) => { stdinEndResolve = r; });

  /** The child process returned by spawn */
  let mockChild: MockChildProcess;

  const spawnFn = ((bin: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ bin, args, opts });

    const child = new EventEmitter() as MockChildProcess;
    child.pid = 12345;

    child.stdout = new MockStream();
    child.stderr = new MockStream();

    child.stdin = new Writable({
      write(chunk, _encoding, cb) {
        stdinData += chunk.toString();
        cb();
      },
      final(cb) {
        stdinEndResolve?.();
        cb();
      },
    });

    mockChild = child;
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  /** Simulate process completing with given exit code and output */
  function complete(exitCode: number, stdout = '', stderr = '') {
    if (stdout) mockChild.stdout.emit('data', Buffer.from(stdout));
    if (stderr) mockChild.stderr.emit('data', Buffer.from(stderr));
    mockChild.emit('close', exitCode, null);
  }

  /** Simulate a spawn error (e.g. ENOENT) */
  function emitError(err: Error) {
    mockChild.emit('error', err);
  }

  return {
    spawnFn,
    calls,
    get stdinData() { return stdinData; },
    stdinEnded,
    complete,
    emitError,
    get child() { return mockChild; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InteractiveTaskExecutor', () => {
  it('returns an object with execute method', () => {
    const executor = createInteractiveExecutor();
    assert.ok(executor);
    assert.equal(typeof executor.execute, 'function');
  });

  describe('execute() — spawn arguments', () => {
    it('spawns claude with correct args and CWD set to worktreePath', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const request = makeRequest({ worktreePath: '/tmp/orch-agents/plan-42' });
      const promise = executor.execute(request);

      // Wait for stdin to be written before completing
      await mock.stdinEnded;
      mock.complete(0, 'done');

      await promise;

      assert.equal(mock.calls.length, 1);
      const call = mock.calls[0];
      assert.equal(call.bin, 'claude');
      assert.deepStrictEqual(call.args, ['--print', '--dangerously-skip-permissions', '-']);
      assert.equal(call.opts.cwd, '/tmp/orch-agents/plan-42');
    });

    it('uses custom cliBin when provided', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn, cliBin: '/usr/local/bin/claude' });

      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.equal(mock.calls[0].bin, '/usr/local/bin/claude');
    });

    it('sets FORCE_COLOR=0 in env', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      const env = mock.calls[0].opts.env as Record<string, string>;
      assert.equal(env.FORCE_COLOR, '0');
    });

    it('uses request timeout', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest({ timeout: 120_000 }));
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.equal(mock.calls[0].opts.timeout, 120_000);
    });

    it('falls back to defaultTimeout when request timeout is 0', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn, defaultTimeout: 180_000 });

      const promise = executor.execute(makeRequest({ timeout: 0 }));
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.equal(mock.calls[0].opts.timeout, 180_000);
    });
  });

  describe('execute() — prompt construction', () => {
    it('prepends worktree context to prompt', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest({
        prompt: 'Fix the bug in auth.ts',
        worktreePath: '/tmp/orch-agents/plan-99',
      }));
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.ok(
        mock.stdinData.includes('You are working in directory: /tmp/orch-agents/plan-99'),
        'Prompt should contain worktree path context',
      );
      assert.ok(
        mock.stdinData.includes('You MUST edit files directly'),
        'Prompt should instruct direct editing',
      );
      assert.ok(
        mock.stdinData.includes('Fix the bug in auth.ts'),
        'Prompt should contain original prompt',
      );
    });

    it('includes targetFiles in prompt when provided', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest({
        targetFiles: ['src/auth.ts', 'src/middleware.ts'],
      }));
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.ok(
        mock.stdinData.includes('Focus on these files:'),
        'Prompt should mention target files',
      );
      assert.ok(mock.stdinData.includes('src/auth.ts'), 'Should include first file');
      assert.ok(mock.stdinData.includes('src/middleware.ts'), 'Should include second file');
    });

    it('does not include targetFiles section when array is empty', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest({ targetFiles: [] }));
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.ok(
        !mock.stdinData.includes('Focus on these files:'),
        'Prompt should not mention target files when empty',
      );
    });

    it('includes priorPhaseOutputs when provided', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest({
        priorPhaseOutputs: ['spec output here', 'architecture output here'],
      }));
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.ok(
        mock.stdinData.includes('Prior analysis:'),
        'Prompt should mention prior analysis',
      );
      assert.ok(mock.stdinData.includes('spec output here'), 'Should include first output');
      assert.ok(mock.stdinData.includes('architecture output here'), 'Should include second output');
      assert.ok(mock.stdinData.includes('---'), 'Should separate outputs with divider');
    });

    it('does not include priorPhaseOutputs section when not provided', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.ok(
        !mock.stdinData.includes('Prior analysis:'),
        'Prompt should not mention prior analysis when not provided',
      );
    });
  });

  describe('execute() — result handling', () => {
    it('returns completed status on exit code 0', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(0, 'Files edited successfully');

      const result = await promise;
      assert.equal(result.status, 'completed');
      assert.equal(result.output, 'Files edited successfully');
      assert.ok(result.duration >= 0);
      assert.equal(result.error, undefined);
    });

    it('returns failed status on non-zero exit code', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(1, '', 'Permission denied');

      const result = await promise;
      assert.equal(result.status, 'failed');
      assert.equal(result.output, '');
      assert.ok(result.error?.includes('code 1'), 'Error should mention exit code');
      assert.ok(result.duration >= 0);
    });

    it('returns failed on spawn error', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest());
      // Don't wait for stdinEnded — error fires before stdin finishes
      mock.emitError(new Error('spawn ENOENT'));

      const result = await promise;
      assert.equal(result.status, 'failed');
      assert.ok(result.error?.includes('ENOENT'), 'Error should mention ENOENT');
      assert.ok(result.duration >= 0);
    });

    it('returns raw stdout without JSON extraction', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const output = 'I edited src/auth.ts and added the middleware.\nDone.';
      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(0, output);

      const result = await promise;
      assert.equal(result.status, 'completed');
      assert.equal(result.output, output, 'Should return raw stdout, not extracted JSON');
    });
  });

  describe('execute() — logger instrumentation', () => {
    it('logs process spawned with worktreePath', async () => {
      const logger = makeSpyLogger();
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn, logger });

      const promise = executor.execute(makeRequest({
        worktreePath: '/tmp/test-wt',
        agentRole: 'coder',
        phaseType: 'refinement',
      }));
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      const spawnLog = logger.calls.find((c) => c.msg === 'Interactive executor: process spawned');
      assert.ok(spawnLog, 'Should log process spawned');
      assert.equal(spawnLog!.ctx?.agentRole, 'coder');
      assert.equal(spawnLog!.ctx?.phaseType, 'refinement');
      assert.equal(spawnLog!.ctx?.worktreePath, '/tmp/test-wt');
      assert.ok(spawnLog!.ctx?.pid !== undefined, 'Should include pid');
    });

    it('logs prompt delivered with promptBytes', async () => {
      const logger = makeSpyLogger();
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn, logger });

      const promise = executor.execute(makeRequest({ agentRole: 'tester' }));
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      const deliverLog = logger.calls.find((c) => c.msg === 'Interactive executor: prompt delivered');
      assert.ok(deliverLog, 'Should log prompt delivered');
      assert.equal(deliverLog!.ctx?.agentRole, 'tester');
      assert.ok(typeof deliverLog!.ctx?.promptBytes === 'number', 'Should include promptBytes');
    });

    it('logs process exited on success', async () => {
      const logger = makeSpyLogger();
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn, logger });

      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(0, 'output here');
      await promise;

      const exitLog = logger.calls.find((c) => c.msg === 'Interactive executor: process exited');
      assert.ok(exitLog, 'Should log process exited');
      assert.equal(exitLog!.ctx?.exitCode, 0);
      assert.ok(typeof exitLog!.ctx?.stdoutLen === 'number');
      assert.ok(typeof exitLog!.ctx?.durationMs === 'number');
    });

    it('logs process failed on non-zero exit', async () => {
      const logger = makeSpyLogger();
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn, logger });

      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(1, '', 'error msg');
      await promise;

      const failLog = logger.calls.find((c) => c.msg === 'Interactive executor: process failed');
      assert.ok(failLog, 'Should log process failed');
      assert.ok(failLog!.ctx?.stderrPreview !== undefined);
      assert.ok(typeof failLog!.ctx?.durationMs === 'number');
    });

    it('works without logger (no crash)', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(0, 'ok');

      const result = await promise;
      assert.ok(result.status, 'Should return a result without logger');
    });
  });

  describe('execute() — defaults', () => {
    it('default timeout is 300_000 (5 min)', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest({ timeout: 0 }));
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.equal(mock.calls[0].opts.timeout, 300_000);
    });

    it('includes allowed tools in prompt', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({ spawnFn: mock.spawnFn });

      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.ok(mock.stdinData.includes('Edit'), 'Should mention Edit tool');
      assert.ok(mock.stdinData.includes('Write'), 'Should mention Write tool');
      assert.ok(mock.stdinData.includes('Read'), 'Should mention Read tool');
    });

    it('accepts custom allowedTools', async () => {
      const mock = createMockSpawn();
      const executor = createInteractiveExecutor({
        spawnFn: mock.spawnFn,
        allowedTools: ['Edit', 'Read'],
      });

      const promise = executor.execute(makeRequest());
      await mock.stdinEnded;
      mock.complete(0, 'ok');
      await promise;

      assert.ok(mock.stdinData.includes('Edit, Read'), 'Should use custom tools');
    });
  });
});
