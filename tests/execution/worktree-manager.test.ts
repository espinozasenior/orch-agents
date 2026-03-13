/**
 * TDD: Tests for WorktreeManager — manages git worktrees for isolated agent execution.
 *
 * London School: child_process.execFile is fully mocked via dependency injection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WorktreeHandle } from '../../src/types';
import type { Logger, LogContext } from '../../src/shared/logger';
import {
  type WorktreeManager,
  type WorktreeManagerDeps,
  createWorktreeManager,
} from '../../src/execution/worktree-manager';
import { ValidationError, ExecutionError } from '../../src/shared/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub logger that records nothing. */
function stubLogger(): Logger {
  const noop = () => {};
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => stubLogger(),
  };
}

/** Recorded call to the mock exec function. */
interface ExecCall {
  cmd: string;
  args: readonly string[];
}

/**
 * Create a mock exec function that records calls and returns configurable output.
 *
 * By default all calls succeed with empty stdout/stderr.
 * Override behavior per-command with the `overrides` map:
 *   key = first arg (e.g. 'git'), value = function that returns { stdout, stderr } or throws.
 */
function mockExec(options: {
  /** Map of handler overrides keyed by a match function or default behavior. */
  handler?: (cmd: string, args: readonly string[]) => { stdout: string; stderr: string } | Promise<{ stdout: string; stderr: string }>;
} = {}) {
  const calls: ExecCall[] = [];

  const defaultHandler = () => ({ stdout: '', stderr: '' });

  const exec = async (cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args });
    const handler = options.handler ?? defaultHandler;
    return handler(cmd, args);
  };

  return { exec: exec as unknown as WorktreeManagerDeps['exec'], calls };
}

function makeDeps(overrides: Partial<WorktreeManagerDeps> & { exec: WorktreeManagerDeps['exec'] }): WorktreeManagerDeps {
  return {
    logger: stubLogger(),
    basePath: '/tmp/orch-agents',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorktreeManager', () => {
  describe('createWorktreeManager()', () => {
    it('returns a WorktreeManager object', () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));
      assert.ok(manager);
      assert.equal(typeof manager.create, 'function');
      assert.equal(typeof manager.commit, 'function');
      assert.equal(typeof manager.push, 'function');
      assert.equal(typeof manager.diff, 'function');
      assert.equal(typeof manager.dispose, 'function');
    });
  });

  describe('create()', () => {
    it('runs correct git worktree add command', async () => {
      const { exec, calls } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle = await manager.create('plan-001', 'main', 'work/plan-001');

      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'git');
      assert.deepEqual(calls[0].args, [
        'worktree', 'add', '/tmp/orch-agents/plan-001', '-b', 'work/plan-001', 'main',
      ]);

      assert.equal(handle.planId, 'plan-001');
      assert.equal(handle.path, '/tmp/orch-agents/plan-001');
      assert.equal(handle.branch, 'work/plan-001');
      assert.equal(handle.baseBranch, 'main');
      assert.equal(handle.status, 'active');
    });

    it('uses custom basePath', async () => {
      const { exec, calls } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec, basePath: '/custom/path' }));

      await manager.create('plan-002', 'develop', 'work/plan-002');

      assert.equal(calls[0].args[2], '/custom/path/plan-002');
    });

    it('rejects planId with path traversal (../)', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('../escape', 'main', 'work/escape'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, /path traversal/i);
          return true;
        },
      );
    });

    it('rejects planId with absolute path', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('/etc/passwd', 'main', 'work/bad'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          return true;
        },
      );
    });

    it('rejects empty planId', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('', 'main', 'work/empty'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          return true;
        },
      );
    });

    it('rejects baseBranch starting with "-" (argument injection)', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-ok', '--upload-pack=evil', 'work/ok'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, /branch name/i);
          return true;
        },
      );
    });

    it('rejects workBranch starting with "-" (argument injection)', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-ok', 'main', '--evil-flag'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, /branch name/i);
          return true;
        },
      );
    });

    it('rejects branch name with ".."', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-ok', 'main', 'work/../escape'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          return true;
        },
      );
    });

    it('rejects branch name with null bytes', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-ok', 'main', 'work/\x00bad'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          return true;
        },
      );
    });

    it('rejects empty branch name', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-ok', '', 'work/ok'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          return true;
        },
      );
    });

    it('rejects branch name with spaces', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-ok', 'main', 'work/bad branch'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          return true;
        },
      );
    });

    it('rejects branch name starting with "/"', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-ok', '/bad', 'work/ok'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          return true;
        },
      );
    });

    it('rejects branch name ending with ".lock"', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-ok', 'main', 'work/branch.lock'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          return true;
        },
      );
    });

    it('rejects branch name ending with "/"', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-ok', 'main', 'work/branch/'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          return true;
        },
      );
    });

    it('rejects branch name ending with "."', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-ok', 'main', 'work/branch.'),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          return true;
        },
      );
    });

    it('rejects branch name with special chars (~, ^, :, ?, *, [, \\)', async () => {
      const { exec } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      for (const char of ['~', '^', ':', '?', '*', '[', '\\']) {
        await assert.rejects(
          () => manager.create('plan-ok', 'main', `work/bad${char}name`),
          (err: unknown) => {
            assert.ok(err instanceof ValidationError, `Should reject char: ${char}`);
            return true;
          },
        );
      }
    });

    it('throws ExecutionError when git worktree add fails', async () => {
      const { exec } = mockExec({
        handler: () => { throw new Error('fatal: worktree already exists'); },
      });
      const manager = createWorktreeManager(makeDeps({ exec }));

      await assert.rejects(
        () => manager.create('plan-fail', 'main', 'work/fail'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.match(err.message, /worktree already exists/);
          return true;
        },
      );
    });
  });

  describe('commit()', () => {
    it('runs git add + commit, returns SHA', async () => {
      const { exec, calls } = mockExec({
        handler: (cmd, args) => {
          if (args.includes('commit')) {
            return { stdout: '[work/plan-001 abc1234] fix: changes\n', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      });
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle: WorktreeHandle = {
        planId: 'plan-001',
        path: '/tmp/orch-agents/plan-001',
        branch: 'work/plan-001',
        baseBranch: 'main',
        status: 'active',
      };

      const sha = await manager.commit(handle, 'fix: changes');

      // Should have called git add -A and git commit -m
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].args, ['-C', '/tmp/orch-agents/plan-001', 'add', '-A']);
      assert.deepEqual(calls[1].args, ['-C', '/tmp/orch-agents/plan-001', 'commit', '-m', 'fix: changes']);

      assert.equal(sha, 'abc1234');
      assert.equal(handle.status, 'committed');
    });

    it('handles empty diff (nothing to commit)', async () => {
      const { exec } = mockExec({
        handler: (_cmd, args) => {
          if (args.includes('commit')) {
            throw new Error('nothing to commit, working tree clean');
          }
          return { stdout: '', stderr: '' };
        },
      });
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle: WorktreeHandle = {
        planId: 'plan-empty',
        path: '/tmp/orch-agents/plan-empty',
        branch: 'work/plan-empty',
        baseBranch: 'main',
        status: 'active',
      };

      await assert.rejects(
        () => manager.commit(handle, 'nothing changed'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.match(err.message, /nothing to commit/i);
          return true;
        },
      );
    });

    it('returns "unknown" SHA when output format is unexpected', async () => {
      const { exec } = mockExec({
        handler: (_cmd, args) => {
          if (args.includes('commit')) {
            return { stdout: 'Unexpected output format\n', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      });
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle: WorktreeHandle = {
        planId: 'plan-weird',
        path: '/tmp/orch-agents/plan-weird',
        branch: 'work/plan-weird',
        baseBranch: 'main',
        status: 'active',
      };

      const sha = await manager.commit(handle, 'weird output');
      assert.equal(sha, 'unknown');
      assert.equal(handle.status, 'committed');
    });
  });

  describe('push()', () => {
    it('runs git push with correct args', async () => {
      const { exec, calls } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle: WorktreeHandle = {
        planId: 'plan-push',
        path: '/tmp/orch-agents/plan-push',
        branch: 'work/plan-push',
        baseBranch: 'main',
        status: 'committed',
      };

      await manager.push(handle);

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, [
        '-C', '/tmp/orch-agents/plan-push', 'push', '-u', 'origin', 'work/plan-push',
      ]);
      assert.equal(handle.status, 'pushed');
    });

    it('throws ExecutionError when push fails', async () => {
      const { exec } = mockExec({
        handler: () => { throw new Error('remote: Permission denied'); },
      });
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle: WorktreeHandle = {
        planId: 'plan-push-fail',
        path: '/tmp/orch-agents/plan-push-fail',
        branch: 'work/plan-push-fail',
        baseBranch: 'main',
        status: 'committed',
      };

      await assert.rejects(
        () => manager.push(handle),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.match(err.message, /Permission denied/);
          return true;
        },
      );
    });
  });

  describe('diff()', () => {
    it('returns diff string from git diff HEAD', async () => {
      const diffOutput = 'diff --git a/file.ts b/file.ts\n+new line\n';
      const { exec } = mockExec({
        handler: (_cmd, args) => {
          if (args.includes('HEAD')) {
            return { stdout: diffOutput, stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      });
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle: WorktreeHandle = {
        planId: 'plan-diff',
        path: '/tmp/orch-agents/plan-diff',
        branch: 'work/plan-diff',
        baseBranch: 'main',
        status: 'active',
      };

      const result = await manager.diff(handle);
      assert.equal(result, diffOutput);
    });

    it('falls back to --cached diff when HEAD diff is empty', async () => {
      const cachedDiff = 'diff --git a/staged.ts b/staged.ts\n+staged line\n';
      const { exec, calls } = mockExec({
        handler: (_cmd, args) => {
          if (args.includes('HEAD')) {
            return { stdout: '', stderr: '' };
          }
          if (args.includes('--cached')) {
            return { stdout: cachedDiff, stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      });
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle: WorktreeHandle = {
        planId: 'plan-cached',
        path: '/tmp/orch-agents/plan-cached',
        branch: 'work/plan-cached',
        baseBranch: 'main',
        status: 'active',
      };

      const result = await manager.diff(handle);
      assert.equal(result, cachedDiff);
      // Should have called both git diff HEAD and git diff --cached
      assert.equal(calls.length, 2);
    });
  });

  describe('dispose()', () => {
    it('removes worktree and updates status', async () => {
      const { exec, calls } = mockExec();
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle: WorktreeHandle = {
        planId: 'plan-dispose',
        path: '/tmp/orch-agents/plan-dispose',
        branch: 'work/plan-dispose',
        baseBranch: 'main',
        status: 'active',
      };

      await manager.dispose(handle);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'git');
      assert.deepEqual(calls[0].args, [
        'worktree', 'remove', '/tmp/orch-agents/plan-dispose', '--force',
      ]);
      assert.equal(handle.status, 'disposed');
    });

    it('falls back to rm -rf on worktree remove failure', async () => {
      let callCount = 0;
      const { exec, calls } = mockExec({
        handler: (cmd, args) => {
          callCount++;
          if (callCount === 1) {
            // First call: git worktree remove fails
            throw new Error('fatal: worktree is dirty');
          }
          // Second call: rm -rf succeeds
          return { stdout: '', stderr: '' };
        },
      });
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle: WorktreeHandle = {
        planId: 'plan-dirty',
        path: '/tmp/orch-agents/plan-dirty',
        branch: 'work/plan-dirty',
        baseBranch: 'main',
        status: 'active',
      };

      // Should NOT throw — fallback handles cleanup
      await manager.dispose(handle);

      assert.equal(calls.length, 2);
      assert.equal(calls[0].cmd, 'git');
      assert.deepEqual(calls[0].args, [
        'worktree', 'remove', '/tmp/orch-agents/plan-dirty', '--force',
      ]);
      assert.equal(calls[1].cmd, 'rm');
      assert.deepEqual(calls[1].args, ['-rf', '/tmp/orch-agents/plan-dirty']);
      assert.equal(handle.status, 'disposed');
    });

    it('still sets status to disposed even when both cleanup methods fail', async () => {
      const { exec } = mockExec({
        handler: () => { throw new Error('cleanup failed'); },
      });
      const manager = createWorktreeManager(makeDeps({ exec }));

      const handle: WorktreeHandle = {
        planId: 'plan-fail-all',
        path: '/tmp/orch-agents/plan-fail-all',
        branch: 'work/plan-fail-all',
        baseBranch: 'main',
        status: 'active',
      };

      // Should NOT throw even when both fail
      await manager.dispose(handle);
      assert.equal(handle.status, 'disposed');
    });
  });
});
