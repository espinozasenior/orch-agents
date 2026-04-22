/**
 * PostExecutionActions tests — London School TDD with mocked deps.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  runPostExecutionActions,
  type PostExecutionDeps,
  type PostExecutionContext,
} from '../../src/execution/post-execution-actions';
import type { GitHubClient } from '../../src/integration/github-client';
import type { IntakeEvent } from '../../src/types';
import { planId, workItemId, linearIssueId, agentSessionId } from '../../src/kernel/branded-types';
import { clearTrackedCommits, isAgentCommit, clearTrackedPRs, isAgentPR } from '../../src/execution/agent-commit-tracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CallLog {
  method: string;
  args: unknown[];
}

function createMockGitHubClient(): { client: GitHubClient; calls: CallLog[] } {
  const calls: CallLog[] = [];

  const client: GitHubClient = {
    async postPRComment(...args) { calls.push({ method: 'postPRComment', args }); },
    async postInlineComment(...args) { calls.push({ method: 'postInlineComment', args }); },
    async pushBranch(...args) { calls.push({ method: 'pushBranch', args }); },
    async submitReview(...args) { calls.push({ method: 'submitReview', args }); },
    async prView(...args) { calls.push({ method: 'prView', args }); return ''; },
    async prDiff(...args) { calls.push({ method: 'prDiff', args }); return ''; },
    async issueView(...args) { calls.push({ method: 'issueView', args }); return ''; },
    async prChecks(...args) { calls.push({ method: 'prChecks', args }); return ''; },
    async createPR(...args) {
      calls.push({ method: 'createPR', args });
      return { number: 99, url: 'https://github.com/owner/repo/pull/99' };
    },
    async createIssue(...args) {
      calls.push({ method: 'createIssue', args });
      return { number: 55, url: 'https://github.com/owner/repo/issues/55' };
    },
  };

  return { client, calls };
}

function makeContext(overrides: Partial<PostExecutionContext> = {}): PostExecutionContext {
  return {
    agent: { type: 'coordinator', role: 'coordinator' },
    planId: 'plan-1',
    workItemId: 'ENG-1',
    agentStart: Date.now() - 5000,
    apply: { commitSha: 'abc1234def', changedFiles: ['src/foo.ts'] },
    exec: { output: 'Done', status: 'completed' },
    intake: {
      id: 'intake-1',
      timestamp: new Date().toISOString(),
      source: 'linear',
      sourceMetadata: { source: 'linear' as const, linearIssueId: linearIssueId('issue-1'), agentSessionId: agentSessionId('session-1'), intent: 'custom:linear-prompted' },
      entities: { requirementId: 'ENG-1', branch: 'feature-branch', repo: 'owner/repo' },
      rawText: 'Fix the bug',
    } as IntakeEvent,
    worktree: { path: '/tmp/orch-agents/plan-1', branch: 'agent/plan-1/coordinator', baseBranch: 'main' },
    findings: [],
    ...overrides,
  };
}

function noopLogger(): PostExecutionDeps['logger'] {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    child: () => noopLogger(),
  } as unknown as PostExecutionDeps['logger'];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostExecutionActions', () => {
  beforeEach(() => {
    clearTrackedCommits();
    clearTrackedPRs();
  });

  describe('pushBranch', () => {
    it('pushes branch when commitSha exists', async () => {
      const { client, calls } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const result = await runPostExecutionActions(deps, makeContext());

      const pushCalls = calls.filter((c) => c.method === 'pushBranch');
      assert.equal(pushCalls.length, 1);
      assert.equal(result.pushed, true);
    });

    it('skips push when no commitSha', async () => {
      const { client, calls } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const result = await runPostExecutionActions(deps, makeContext({
        apply: { commitSha: undefined, changedFiles: [] },
      }));

      const pushCalls = calls.filter((c) => c.method === 'pushBranch');
      assert.equal(pushCalls.length, 0);
      assert.equal(result.pushed, false);
    });

    it('tracks agent commit SHA', async () => {
      const { client } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      await runPostExecutionActions(deps, makeContext());

      assert.equal(isAgentCommit('abc1234def'), true);
    });
  });

  describe('createPRIfNeeded', () => {
    it('creates PR when branch pushed and no existing prNumber', async () => {
      const { client, calls } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const ctx = makeContext();
      // Remove prNumber so PR creation triggers
      (ctx.intake.entities as Record<string, unknown>).prNumber = undefined;

      const result = await runPostExecutionActions(deps, ctx);

      const createCalls = calls.filter((c) => c.method === 'createPR');
      assert.equal(createCalls.length, 1);
      assert.equal(result.prCreated, true);
      assert.equal(result.prNumber, 99);
    });

    it('skips PR creation when prNumber already exists on intake', async () => {
      const { client, calls } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const ctx = makeContext();
      (ctx.intake.entities as Record<string, unknown>).prNumber = 42;

      const result = await runPostExecutionActions(deps, ctx);

      const createCalls = calls.filter((c) => c.method === 'createPR');
      assert.equal(createCalls.length, 0);
      assert.equal(result.prCreated, false);
    });

    it('tracks created PR for feedback loop prevention', async () => {
      const { client } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const ctx = makeContext();
      (ctx.intake.entities as Record<string, unknown>).prNumber = undefined;

      await runPostExecutionActions(deps, ctx);

      assert.equal(isAgentPR('owner/repo', 99), true);
    });

    it('handles "already exists" error gracefully', async () => {
      const { client, calls } = createMockGitHubClient();
      // Override createPR to throw "already exists"
      client.createPR = async () => { throw new Error('A pull request already exists for feature-branch'); };
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const ctx = makeContext();
      (ctx.intake.entities as Record<string, unknown>).prNumber = undefined;

      const result = await runPostExecutionActions(deps, ctx);

      assert.equal(result.prCreated, false);
      // Should not throw — handled gracefully
    });
  });

  describe('submitReviewWithFindings', () => {
    it('posts inline comments for findings with filePath/lineNumber', async () => {
      const { client, calls } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const ctx = makeContext({
        findings: [
          { id: 'f1', severity: 'warning', category: 'style', message: 'Long line', filePath: 'src/foo.ts', lineNumber: 42, commitSha: 'abc123' },
        ],
      });
      (ctx.intake.entities as Record<string, unknown>).prNumber = 10;

      const result = await runPostExecutionActions(deps, ctx);

      const inlineCalls = calls.filter((c) => c.method === 'postInlineComment');
      assert.equal(inlineCalls.length, 1);
      const reviewCalls = calls.filter((c) => c.method === 'submitReview');
      assert.equal(reviewCalls.length, 1);
      assert.equal(result.reviewSubmitted, true);
    });

    it('submits REQUEST_CHANGES for critical findings', async () => {
      const { client, calls } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const ctx = makeContext({
        findings: [
          { id: 'f1', severity: 'critical', category: 'security', message: 'SQL injection' },
        ],
      });
      (ctx.intake.entities as Record<string, unknown>).prNumber = 10;

      await runPostExecutionActions(deps, ctx);

      const reviewCalls = calls.filter((c) => c.method === 'submitReview');
      assert.equal(reviewCalls.length, 1);
      assert.equal((reviewCalls[0].args as unknown[])[2], 'REQUEST_CHANGES');
    });

    it('submits APPROVE when no critical findings', async () => {
      const { client, calls } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const ctx = makeContext({
        findings: [
          { id: 'f1', severity: 'info', category: 'style', message: 'Consider renaming' },
        ],
      });
      (ctx.intake.entities as Record<string, unknown>).prNumber = 10;

      await runPostExecutionActions(deps, ctx);

      const reviewCalls = calls.filter((c) => c.method === 'submitReview');
      assert.equal(reviewCalls.length, 1);
      assert.equal((reviewCalls[0].args as unknown[])[2], 'APPROVE');
    });

    it('skips review when no findings', async () => {
      const { client, calls } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const ctx = makeContext({ findings: [] });
      (ctx.intake.entities as Record<string, unknown>).prNumber = 10;

      const result = await runPostExecutionActions(deps, ctx);

      const reviewCalls = calls.filter((c) => c.method === 'submitReview');
      assert.equal(reviewCalls.length, 0);
      assert.equal(result.reviewSubmitted, false);
    });
  });

  describe('postSummaryComment', () => {
    it('posts comment for non-GitHub sources', async () => {
      const { client, calls } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const ctx = makeContext();
      (ctx.intake.entities as Record<string, unknown>).prNumber = 10;

      const result = await runPostExecutionActions(deps, ctx);

      const commentCalls = calls.filter((c) => c.method === 'postPRComment');
      assert.equal(commentCalls.length, 1);
      assert.equal(result.commentPosted, true);
    });

    it('skips comment for GitHub-sourced events', async () => {
      const { client, calls } = createMockGitHubClient();
      const deps: PostExecutionDeps = { githubClient: client, logger: noopLogger() };

      const ctx = makeContext();
      ctx.intake.source = 'github';
      (ctx.intake.entities as Record<string, unknown>).prNumber = 10;

      const result = await runPostExecutionActions(deps, ctx);

      const commentCalls = calls.filter((c) => c.method === 'postPRComment');
      assert.equal(commentCalls.length, 0);
      assert.equal(result.commentPosted, false);
    });
  });

  describe('no githubClient', () => {
    it('skips all GitHub actions when no client configured', async () => {
      const deps: PostExecutionDeps = { logger: noopLogger() };

      const result = await runPostExecutionActions(deps, makeContext());

      assert.equal(result.pushed, false);
      assert.equal(result.prCreated, false);
      assert.equal(result.reviewSubmitted, false);
      assert.equal(result.commentPosted, false);
    });
  });
});
