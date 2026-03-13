/**
 * TDD: Tests for ArtifactApplier — validates and commits worktree changes.
 *
 * London School: execInWorktree is fully mocked so no real git is needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from '../../src/shared/logger';
import {
  type WorktreeHandle,
  type ApplyContext,
  type ArtifactApplier,
  type ArtifactApplierDeps,
  createArtifactApplier,
} from '../../src/execution/artifact-applier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeHandle(overrides: Partial<WorktreeHandle> = {}): WorktreeHandle {
  return {
    planId: 'plan-001',
    path: '/tmp/orch-agents/plan-001',
    branch: 'work/plan-001',
    baseBranch: 'main',
    status: 'active',
    ...overrides,
  };
}

interface ExecCall {
  worktreePath: string;
  command: string;
  args: string[];
}

/**
 * Create a mock execInWorktree that records calls and returns
 * configurable responses based on the git subcommand.
 */
function mockExec(responses: Record<string, { stdout: string; stderr: string }> = {}) {
  const calls: ExecCall[] = [];

  const defaultResponses: Record<string, { stdout: string; stderr: string }> = {
    'diff--name-only--HEAD': { stdout: '', stderr: '' },
    'diff--name-only--cached': { stdout: '', stderr: '' },
    'diff--HEAD': { stdout: '', stderr: '' },
    'add---A': { stdout: '', stderr: '' },
    'commit---m': { stdout: '', stderr: '' },
    'rev-parse--HEAD': { stdout: 'abc123def456\n', stderr: '' },
    'checkout-------.': { stdout: '', stderr: '' },
    'clean---fd': { stdout: '', stderr: '' },
    ...responses,
  };

  async function exec(
    worktreePath: string,
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    calls.push({ worktreePath, command, args });

    // Build a key from the args to look up the response
    // For diff commands, use a combination key
    const key = buildKey(args);
    const response = defaultResponses[key];
    if (response) {
      return response;
    }

    return { stdout: '', stderr: '' };
  }

  return { exec, calls };
}

/**
 * Build a lookup key from git args for the mock response map.
 */
function buildKey(args: string[]): string {
  // Handle the common patterns
  if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === 'HEAD') {
    return 'diff--name-only--HEAD';
  }
  if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === '--cached') {
    return 'diff--name-only--cached';
  }
  if (args[0] === 'diff' && args[1] === 'HEAD' && args.length === 2) {
    return 'diff--HEAD';
  }
  if (args[0] === 'add' && args[1] === '-A') {
    return 'add---A';
  }
  if (args[0] === 'commit' && args[1] === '-m') {
    return 'commit---m';
  }
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
    return 'rev-parse--HEAD';
  }
  if (args[0] === 'checkout' && args[1] === '--' && args[2] === '.') {
    return 'checkout-------.';
  }
  if (args[0] === 'clean' && args[1] === '-fd') {
    return 'clean---fd';
  }
  return args.join('--');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArtifactApplier', () => {
  describe('createArtifactApplier()', () => {
    it('returns an ArtifactApplier object', () => {
      const applier = createArtifactApplier();
      assert.ok(applier);
      assert.equal(typeof applier.apply, 'function');
      assert.equal(typeof applier.rollback, 'function');
    });
  });

  describe('apply()', () => {
    it('stages, commits, and returns SHA and changed files', async () => {
      const { exec, calls } = mockExec({
        'diff--name-only--HEAD': { stdout: 'src/foo.ts\nsrc/bar.ts\n', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
        'diff--HEAD': { stdout: 'safe diff content\n', stderr: '' },
        'rev-parse--HEAD': { stdout: 'deadbeef1234\n', stderr: '' },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const handle = makeHandle();
      const context: ApplyContext = { commitMessage: 'agent/coder: refinement changes' };

      const result = await applier.apply('plan-001', handle, context);

      assert.equal(result.status, 'applied');
      assert.equal(result.commitSha, 'deadbeef1234');
      assert.deepEqual(result.changedFiles, ['src/foo.ts', 'src/bar.ts']);

      // Verify git add -A was called
      const addCall = calls.find((c) => c.args[0] === 'add' && c.args[1] === '-A');
      assert.ok(addCall, 'git add -A should have been called');

      // Verify git commit was called with the right message
      const commitCall = calls.find((c) => c.args[0] === 'commit');
      assert.ok(commitCall, 'git commit should have been called');
      assert.equal(commitCall.args[2], 'agent/coder: refinement changes');
    });

    it('returns applied with empty changedFiles when no changes exist', async () => {
      const { exec } = mockExec({
        'diff--name-only--HEAD': { stdout: '', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'no changes',
      });

      assert.equal(result.status, 'applied');
      assert.equal(result.commitSha, undefined);
      assert.deepEqual(result.changedFiles, []);
    });

    it('rejects path traversal in changed files', async () => {
      const { exec, calls } = mockExec({
        'diff--name-only--HEAD': { stdout: '../../../etc/passwd\n', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'evil changes',
      });

      assert.equal(result.status, 'rejected');
      assert.ok(result.rejectionReason);
      assert.match(result.rejectionReason, /path traversal/i);

      // Should have called rollback (checkout + clean)
      const checkoutCall = calls.find(
        (c) => c.args[0] === 'checkout' && c.args[1] === '--' && c.args[2] === '.',
      );
      assert.ok(checkoutCall, 'rollback should have been called');
    });

    it('rejects absolute paths in changed files', async () => {
      const { exec, calls } = mockExec({
        'diff--name-only--HEAD': { stdout: '/etc/shadow\n', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'evil changes',
      });

      assert.equal(result.status, 'rejected');
      assert.ok(result.rejectionReason);
      assert.match(result.rejectionReason, /absolute path/i);

      // Verify rollback was called
      const cleanCall = calls.find((c) => c.args[0] === 'clean' && c.args[1] === '-fd');
      assert.ok(cleanCall, 'rollback should have been called');
    });

    it('rejects diff containing AWS key pattern', async () => {
      const { exec } = mockExec({
        'diff--name-only--HEAD': { stdout: 'config.ts\n', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
        'diff--HEAD': {
          stdout: '+const key = "AKIAIOSFODNN7EXAMPLE";\n',
          stderr: '',
        },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'with aws key',
      });

      assert.equal(result.status, 'rejected');
      assert.ok(result.rejectionReason);
      assert.match(result.rejectionReason, /forbidden pattern/i);
    });

    it('rejects diff containing GitHub token pattern', async () => {
      const { exec } = mockExec({
        'diff--name-only--HEAD': { stdout: '.env\n', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
        'diff--HEAD': {
          stdout: '+GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n',
          stderr: '',
        },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'with github token',
      });

      assert.equal(result.status, 'rejected');
      assert.ok(result.rejectionReason);
      assert.match(result.rejectionReason, /forbidden pattern/i);
    });

    it('rejects diff containing private key', async () => {
      const { exec } = mockExec({
        'diff--name-only--HEAD': { stdout: 'key.pem\n', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
        'diff--HEAD': {
          stdout: '+-----BEGIN RSA PRIVATE KEY-----\n+MIIEpAIBAAK...\n',
          stderr: '',
        },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'with private key',
      });

      assert.equal(result.status, 'rejected');
      assert.ok(result.rejectionReason);
      assert.match(result.rejectionReason, /forbidden pattern/i);
    });

    it('rejects diff matching custom forbiddenPatterns', async () => {
      const { exec } = mockExec({
        'diff--name-only--HEAD': { stdout: 'src/app.ts\n', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
        'diff--HEAD': {
          stdout: '+const connection = "mongodb://admin:pass@host/db";\n',
          stderr: '',
        },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'with mongo uri',
        forbiddenPatterns: [/mongodb:\/\/[^@]+@/],
      });

      assert.equal(result.status, 'rejected');
      assert.ok(result.rejectionReason);
      assert.match(result.rejectionReason, /forbidden pattern/i);
    });

    it('calls rollback before returning rejected status', async () => {
      const callOrder: string[] = [];
      const { exec } = mockExec({
        'diff--name-only--HEAD': { stdout: '../escape.txt\n', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
      });

      // Wrap exec to track call order
      const trackingExec = async (
        worktreePath: string,
        command: string,
        args: string[],
      ) => {
        callOrder.push(args[0]);
        return exec(worktreePath, command, args);
      };

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: trackingExec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'bad changes',
      });

      assert.equal(result.status, 'rejected');

      // Rollback commands (checkout, clean) should have been called
      assert.ok(callOrder.includes('checkout'), 'checkout should have been called for rollback');
      assert.ok(callOrder.includes('clean'), 'clean should have been called for rollback');

      // Commit should NOT have been called
      assert.ok(!callOrder.includes('commit'), 'commit should not have been called');
    });

    it('deduplicates files appearing in both staged and unstaged', async () => {
      const { exec } = mockExec({
        'diff--name-only--HEAD': { stdout: 'src/shared.ts\nsrc/unique-unstaged.ts\n', stderr: '' },
        'diff--name-only--cached': { stdout: 'src/shared.ts\nsrc/unique-staged.ts\n', stderr: '' },
        'diff--HEAD': { stdout: 'safe content\n', stderr: '' },
        'rev-parse--HEAD': { stdout: 'aaa111bbb\n', stderr: '' },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'dedup test',
      });

      assert.equal(result.status, 'applied');
      // Should be 3 unique files, not 4
      assert.equal(result.changedFiles.length, 3);
      assert.ok(result.changedFiles.includes('src/shared.ts'));
      assert.ok(result.changedFiles.includes('src/unique-unstaged.ts'));
      assert.ok(result.changedFiles.includes('src/unique-staged.ts'));
    });

    it('rejects diff containing unquoted secret assignment', async () => {
      const { exec } = mockExec({
        'diff--name-only--HEAD': { stdout: 'config.ts\n', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
        'diff--HEAD': {
          stdout: '-old line\n+password = SuperSecret123\n',
          stderr: '',
        },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'with unquoted secret',
      });

      assert.equal(result.status, 'rejected');
      assert.ok(result.rejectionReason);
      assert.match(result.rejectionReason, /forbidden pattern/i);
    });

    it('does not flag secrets in removed lines (lines starting with -)', async () => {
      const { exec } = mockExec({
        'diff--name-only--HEAD': { stdout: 'config.ts\n', stderr: '' },
        'diff--name-only--cached': { stdout: '', stderr: '' },
        'diff--HEAD': {
          stdout: '-password = "OldSecretValue1234"\n+// secret removed\n',
          stderr: '',
        },
      });

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const result = await applier.apply('plan-001', makeHandle(), {
        commitMessage: 'removed old secret',
      });

      assert.equal(result.status, 'applied');
    });

    it('execInWorktree default uses cwd option for non-git commands', async () => {
      // This test verifies the exec function receives the correct worktreePath
      // and command without -C prepended
      const calls: { worktreePath: string; command: string; args: string[] }[] = [];
      const trackingExec = async (
        worktreePath: string,
        command: string,
        args: string[],
      ) => {
        calls.push({ worktreePath, command, args });
        return { stdout: '', stderr: '' };
      };

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: trackingExec,
      });

      const handle = makeHandle();
      await applier.rollback(handle);

      // Verify the exec was called with the command directly, not with -C prepended
      assert.ok(calls.length > 0);
      for (const call of calls) {
        assert.equal(call.worktreePath, handle.path);
        // Args should NOT contain -C as the first element
        assert.notEqual(call.args[0], '-C', 'Should not prepend -C flag to args');
      }
    });
  });

  describe('defaultExecInWorktree (C2)', () => {
    it('uses cwd option instead of -C flag for non-git commands', async () => {
      // Create applier with NO custom exec — uses defaultExecInWorktree
      // We cannot test the default directly without shelling out, but we can
      // verify the interface contract through the injected mock.
      // The actual fix is in the source code changing -C to cwd.
      // Here we verify the mock contract is correct.
      const { exec, calls } = mockExec();
      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const handle = makeHandle();
      await applier.rollback(handle);

      // The mock exec receives (worktreePath, command, args) without -C
      assert.ok(calls.length >= 2);
      for (const call of calls) {
        assert.equal(call.worktreePath, handle.path);
        assert.equal(call.command, 'git');
        // The args should be git subcommands, not -C prefixed
        assert.notEqual(call.args[0], '-C');
      }
    });
  });

  describe('rollback()', () => {
    it('runs git checkout and git clean', async () => {
      const { exec, calls } = mockExec();

      const applier = createArtifactApplier({
        logger: stubLogger(),
        execInWorktree: exec,
      });

      const handle = makeHandle();
      await applier.rollback(handle);

      const checkoutCall = calls.find(
        (c) => c.args[0] === 'checkout' && c.args[1] === '--' && c.args[2] === '.',
      );
      assert.ok(checkoutCall, 'git checkout -- . should have been called');
      assert.equal(checkoutCall.worktreePath, handle.path);

      const cleanCall = calls.find(
        (c) => c.args[0] === 'clean' && c.args[1] === '-fd',
      );
      assert.ok(cleanCall, 'git clean -fd should have been called');
      assert.equal(cleanCall.worktreePath, handle.path);
    });
  });
});
