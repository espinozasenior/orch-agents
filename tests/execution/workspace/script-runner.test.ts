/**
 * TDD: Tests for script-runner — shell execution with timeout, env, cwd.
 *
 * London School: execFile is fully mocked via dependency injection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runLifecycleScript } from '../../../src/execution/workspace/script-runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockExecCall {
  cmd: string;
  args: readonly string[];
  opts: Record<string, unknown>;
}

function createMockExec(options: {
  stdout?: string;
  stderr?: string;
  error?: Error & { killed?: boolean; code?: number };
} = {}) {
  const calls: MockExecCall[] = [];

  const exec = async (cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    if (options.error) {
      throw options.error;
    }
    return { stdout: options.stdout ?? '', stderr: options.stderr ?? '' };
  };

  return { exec: exec as Parameters<typeof runLifecycleScript>[4], calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runLifecycleScript', () => {
  it('returns exitCode 0 on success with captured stdout/stderr', async () => {
    const { exec } = createMockExec({ stdout: 'installed\n', stderr: 'warn: something\n' });

    const result = await runLifecycleScript('npm ci', '/tmp/wt', 60_000, undefined, exec);

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'installed\n');
    assert.strictEqual(result.stderr, 'warn: something\n');
    assert.strictEqual(result.timedOut, false);
    assert.ok(result.durationMs >= 0);
  });

  it('returns non-zero exitCode on failure', async () => {
    const err = Object.assign(new Error('exit code 1'), { code: 1, killed: false });
    const { exec } = createMockExec({ error: err });

    const result = await runLifecycleScript('exit 1', '/tmp/wt', 60_000, undefined, exec);

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.timedOut, false);
  });

  it('returns timedOut=true when process was killed by timeout', async () => {
    const err = Object.assign(new Error('timed out'), { killed: true, code: null });
    const { exec } = createMockExec({ error: err });

    const result = await runLifecycleScript('sleep 999', '/tmp/wt', 100, undefined, exec);

    assert.strictEqual(result.timedOut, true);
  });

  it('passes ORCH_BOOT_MODE=fresh in env', async () => {
    const { exec, calls } = createMockExec();

    await runLifecycleScript('echo hi', '/tmp/wt', 60_000, undefined, exec);

    assert.strictEqual(calls.length, 1);
    const env = calls[0].opts.env as Record<string, string>;
    assert.strictEqual(env.ORCH_BOOT_MODE, 'fresh');
  });

  it('merges custom env vars with ORCH_BOOT_MODE', async () => {
    const { exec, calls } = createMockExec();

    await runLifecycleScript('echo hi', '/tmp/wt', 60_000, { FOO: 'bar' }, exec);

    const env = calls[0].opts.env as Record<string, string>;
    assert.strictEqual(env.ORCH_BOOT_MODE, 'fresh');
    assert.strictEqual(env.FOO, 'bar');
  });

  it('passes cwd and timeout to execFile options', async () => {
    const { exec, calls } = createMockExec();

    await runLifecycleScript('ls', '/my/cwd', 45_000, undefined, exec);

    assert.strictEqual(calls[0].opts.cwd, '/my/cwd');
    assert.strictEqual(calls[0].opts.timeout, 45_000);
  });

  it('measures duration in milliseconds', async () => {
    const { exec } = createMockExec();

    const result = await runLifecycleScript('echo fast', '/tmp/wt', 60_000, undefined, exec);

    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.durationMs >= 0);
  });
});
