/**
 * Tests for GitHubClient — London School TDD with mocked exec dependency.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHubClient,
  type GitHubClient,
  type GitHubClientDeps,
} from '../../src/integration/github-client';
import { ExecutionError } from '../../src/shared/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExecCall {
  command: string;
  args: string[];
  opts?: { cwd?: string };
}

function createMockExec() {
  const calls: ExecCall[] = [];
  const exec: GitHubClientDeps['exec'] = async (command, args, opts) => {
    calls.push({ command, args, opts });
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

function createFailingExec(errorMessage = 'command failed') {
  const exec: GitHubClientDeps['exec'] = async () => {
    throw new Error(errorMessage);
  };
  return exec;
}

// ---------------------------------------------------------------------------
// postPRComment
// ---------------------------------------------------------------------------

describe('GitHubClient', () => {
  describe('postPRComment', () => {
    it('calls gh pr comment with correct args', async () => {
      const { exec, calls } = createMockExec();
      const client = createGitHubClient({ exec });

      await client.postPRComment('owner/repo', 42, 'looks good');

      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'gh');
      assert.deepEqual(calls[0].args, [
        'pr', 'comment', '42',
        '--repo', 'owner/repo',
        '--body', 'looks good',
      ]);
    });

    it('throws on invalid repo format', async () => {
      const { exec } = createMockExec();
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.postPRComment('invalid-repo', 1, 'body'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('Invalid repo format'));
          return true;
        },
      );
    });

    it('throws on empty body', async () => {
      const { exec } = createMockExec();
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.postPRComment('owner/repo', 1, ''),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('body must not be empty'));
          return true;
        },
      );
    });

    it('throws on invalid PR number', async () => {
      const { exec } = createMockExec();
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.postPRComment('owner/repo', 0, 'body'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('Invalid PR number'));
          return true;
        },
      );
    });

    it('throws ExecutionError on exec failure', async () => {
      const exec = createFailingExec('network error');
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.postPRComment('owner/repo', 1, 'body'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('network error'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // postInlineComment
  // ---------------------------------------------------------------------------

  describe('postInlineComment', () => {
    it('calls gh api with correct path, line, body, and commitSha', async () => {
      const { exec, calls } = createMockExec();
      const client = createGitHubClient({ exec });

      await client.postInlineComment(
        'owner/repo', 10, 'src/index.ts', 25, 'nit: rename this', 'abc123def',
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'gh');
      assert.deepEqual(calls[0].args, [
        'api', '-X', 'POST',
        'repos/owner/repo/pulls/10/comments',
        '-f', 'body=nit: rename this',
        '-f', 'path=src/index.ts',
        '-F', 'line=25',
        '-f', 'side=RIGHT',
        '-f', 'commit_id=abc123def',
      ]);
    });

    it('throws ExecutionError on exec failure', async () => {
      const exec = createFailingExec('api error');
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.postInlineComment('owner/repo', 1, 'f.ts', 1, 'x'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('api error'));
          return true;
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // pushBranch
  // ---------------------------------------------------------------------------

  describe('pushBranch', () => {
    it('calls git -C with correct worktree and branch', async () => {
      const { exec, calls } = createMockExec();
      const client = createGitHubClient({ exec });

      await client.pushBranch('/tmp/worktree', 'feature/abc');

      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'git');
      assert.deepEqual(calls[0].args, [
        '-C', '/tmp/worktree', 'push', '-u', 'origin', 'feature/abc',
      ]);
    });

    it('throws ExecutionError on exec failure', async () => {
      const exec = createFailingExec('push rejected');
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.pushBranch('/tmp/wt', 'main'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('push rejected'));
          return true;
        },
      );
    });

    it('throws on empty branch name', async () => {
      const { exec } = createMockExec();
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.pushBranch('/tmp/wt', ''),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('branch'));
          return true;
        },
      );
    });

    it('throws on branch name starting with "-"', async () => {
      const { exec } = createMockExec();
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.pushBranch('/tmp/wt', '--evil'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('branch'));
          return true;
        },
      );
    });

    it('throws on empty worktreePath', async () => {
      const { exec } = createMockExec();
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.pushBranch('', 'main'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('worktreePath'));
          return true;
        },
      );
    });

    it('throws on relative worktreePath', async () => {
      const { exec } = createMockExec();
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.pushBranch('relative/path', 'main'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('worktreePath'));
          return true;
        },
      );
    });

    it('uses refspec when remoteBranch option is provided', async () => {
      const { exec, calls } = createMockExec();
      const client = createGitHubClient({ exec });

      await client.pushBranch('/tmp/wt', 'agent/plan-1/coder', {
        remoteBranch: 'feature-branch',
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'git');
      assert.deepEqual(calls[0].args, [
        '-C', '/tmp/wt', 'push', 'origin', 'HEAD:refs/heads/feature-branch',
      ]);
    });

    it('uses simple push when no remoteBranch option', async () => {
      const { exec, calls } = createMockExec();
      const client = createGitHubClient({ exec });

      await client.pushBranch('/tmp/wt', 'main');

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, [
        '-C', '/tmp/wt', 'push', '-u', 'origin', 'main',
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // submitReview
  // ---------------------------------------------------------------------------

  describe('submitReview', () => {
    it('calls gh pr review with --approve for APPROVE', async () => {
      const { exec, calls } = createMockExec();
      const client = createGitHubClient({ exec });

      await client.submitReview('owner/repo', 5, 'APPROVE', 'LGTM');

      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'gh');
      assert.deepEqual(calls[0].args, [
        'pr', 'review', '5',
        '--repo', 'owner/repo',
        '--approve',
        '--body', 'LGTM',
      ]);
    });

    it('calls gh pr review with --request-changes for REQUEST_CHANGES', async () => {
      const { exec, calls } = createMockExec();
      const client = createGitHubClient({ exec });

      await client.submitReview(
        'owner/repo', 7, 'REQUEST_CHANGES', 'Please fix',
      );

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, [
        'pr', 'review', '7',
        '--repo', 'owner/repo',
        '--request-changes',
        '--body', 'Please fix',
      ]);
    });

    it('throws ExecutionError on exec failure', async () => {
      const exec = createFailingExec('review failed');
      const client = createGitHubClient({ exec });

      await assert.rejects(
        () => client.submitReview('owner/repo', 1, 'APPROVE', 'ok'),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionError);
          assert.ok(err.message.includes('review failed'));
          return true;
        },
      );
    });
  });
});
