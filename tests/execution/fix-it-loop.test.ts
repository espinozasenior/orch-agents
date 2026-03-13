/**
 * FixItLoop — London School TDD tests.
 *
 * All four dependencies (FixExecutor, FixReviewer, FixCommitter,
 * FixPromptBuilder) are mocked. Tests verify the orchestration logic
 * without touching any real infrastructure.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFixItLoop,
  type FixExecutor,
  type FixReviewer,
  type FixCommitter,
  type FixPromptBuilder,
  type FixItContext,
  type FixItLoop,
  type FixExecutionResult,
  type FixReviewRequest,
} from '../../src/execution/fix-it-loop';
import type { ReviewVerdict, Finding } from '../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePassVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    phaseResultId: 'pr-1',
    status: 'pass',
    findings: [],
    securityScore: 100,
    testCoveragePercent: 95,
    codeReviewApproval: true,
    ...overrides,
  };
}

function makeFailVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    phaseResultId: 'pr-1',
    status: 'fail',
    findings: [
      {
        id: 'f1',
        severity: 'error',
        category: 'test',
        message: 'Tests failing',
      },
    ],
    securityScore: 50,
    testCoveragePercent: 40,
    codeReviewApproval: false,
    feedback: 'Please fix the failing tests',
    ...overrides,
  };
}

function makeContext(overrides: Partial<FixItContext> = {}): FixItContext {
  return {
    planId: 'plan-1',
    workItemId: 'wi-1',
    branch: 'fix/thing',
    worktreePath: '/tmp/wt',
    initialCommitSha: 'abc123',
    artifacts: [],
    maxAttempts: 3,
    timeout: 30_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface Mocks {
  fixExecutor: FixExecutor;
  fixReviewer: FixReviewer;
  fixCommitter: FixCommitter;
  fixPromptBuilder: FixPromptBuilder;
}

function createMocks(): Mocks {
  return {
    fixExecutor: {
      executeFix: mock.fn(async (): Promise<FixExecutionResult> => ({
        status: 'completed',
        output: 'fix applied',
        duration: 100,
      })),
    },
    fixReviewer: {
      review: mock.fn(async (): Promise<ReviewVerdict> => makePassVerdict()),
    },
    fixCommitter: {
      commit: mock.fn(async (): Promise<string> => 'sha-new'),
      diff: mock.fn(async (): Promise<string> => 'diff content'),
    },
    fixPromptBuilder: {
      build: mock.fn((): string => 'fix prompt'),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FixItLoop', () => {
  let mocks: Mocks;
  let loop: FixItLoop;

  beforeEach(() => {
    mocks = createMocks();
    loop = createFixItLoop({
      fixExecutor: mocks.fixExecutor,
      fixReviewer: mocks.fixReviewer,
      fixCommitter: mocks.fixCommitter,
      fixPromptBuilder: mocks.fixPromptBuilder,
    });
  });

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  it('returns passed immediately when first review passes', async () => {
    // reviewer returns pass on first call
    const result = await loop.run(makeContext());

    assert.equal(result.status, 'passed');
    assert.equal(result.attempts, 1);
    assert.equal(result.finalVerdict.status, 'pass');
    assert.equal(result.commitSha, 'abc123');
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].fixApplied, false);
  });

  // -----------------------------------------------------------------------
  // Fix cycle
  // -----------------------------------------------------------------------

  it('executes fix and re-reviews when first review fails', async () => {
    const reviewFn = mock.fn<(req: FixReviewRequest) => Promise<ReviewVerdict>>();
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict(), 0);
    reviewFn.mock.mockImplementationOnce(async () => makePassVerdict(), 1);
    mocks.fixReviewer.review = reviewFn;
    loop = createFixItLoop({ ...mocks });

    const result = await loop.run(makeContext());

    // Fix executor should have been called once
    assert.equal(
      (mocks.fixExecutor.executeFix as ReturnType<typeof mock.fn>).mock.callCount(),
      1,
    );
    // Committer.commit should have been called once
    assert.equal(
      (mocks.fixCommitter.commit as ReturnType<typeof mock.fn>).mock.callCount(),
      1,
    );
    assert.equal(result.status, 'passed');
  });

  it('passes on second attempt after fix', async () => {
    const reviewFn = mock.fn<(req: FixReviewRequest) => Promise<ReviewVerdict>>();
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict(), 0);
    reviewFn.mock.mockImplementationOnce(async () => makePassVerdict(), 1);
    mocks.fixReviewer.review = reviewFn;
    loop = createFixItLoop({ ...mocks });

    const result = await loop.run(makeContext());

    assert.equal(result.status, 'passed');
    assert.equal(result.attempts, 2);
    assert.equal(result.commitSha, 'sha-new');
  });

  // -----------------------------------------------------------------------
  // Exhaustion
  // -----------------------------------------------------------------------

  it('exhausts all attempts and returns failed', async () => {
    // Every review fails
    mocks.fixReviewer.review = mock.fn(async () => makeFailVerdict());
    loop = createFixItLoop({ ...mocks });

    const result = await loop.run(makeContext({ maxAttempts: 2 }));

    assert.equal(result.status, 'failed');
    assert.equal(result.attempts, 2);
    assert.equal(result.finalVerdict.status, 'fail');
  });

  // -----------------------------------------------------------------------
  // History tracking
  // -----------------------------------------------------------------------

  it('records history for each attempt', async () => {
    const reviewFn = mock.fn<(req: FixReviewRequest) => Promise<ReviewVerdict>>();
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict(), 0);
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict(), 1);
    reviewFn.mock.mockImplementationOnce(async () => makePassVerdict(), 2);
    mocks.fixReviewer.review = reviewFn;
    loop = createFixItLoop({ ...mocks });

    const result = await loop.run(makeContext({ maxAttempts: 3 }));

    assert.equal(result.status, 'passed');
    assert.equal(result.history.length, 3);
    // First two attempts had fixes applied
    assert.equal(result.history[0].fixApplied, true);
    assert.equal(result.history[1].fixApplied, true);
    // Third attempt passed review, no fix needed
    assert.equal(result.history[2].fixApplied, false);
    // Each record has a duration >= 0
    for (const record of result.history) {
      assert.ok(record.duration >= 0, 'duration should be non-negative');
    }
  });

  // -----------------------------------------------------------------------
  // Fix execution failure
  // -----------------------------------------------------------------------

  it('continues to next attempt when fix execution fails', async () => {
    const reviewFn = mock.fn<(req: FixReviewRequest) => Promise<ReviewVerdict>>();
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict(), 0);
    reviewFn.mock.mockImplementationOnce(async () => makePassVerdict(), 1);
    mocks.fixReviewer.review = reviewFn;

    // First fix execution fails
    const execFn = mock.fn<(path: string, prompt: string, timeout: number) => Promise<FixExecutionResult>>();
    execFn.mock.mockImplementationOnce(async () => ({
      status: 'failed' as const,
      output: '',
      duration: 50,
      error: 'timeout',
    }), 0);
    mocks.fixExecutor.executeFix = execFn;
    loop = createFixItLoop({ ...mocks });

    const result = await loop.run(makeContext({ maxAttempts: 2 }));

    // First attempt: review fails, fix fails -> no commit
    assert.equal(result.history[0].fixApplied, false);
    // Second attempt: review passes -> done
    assert.equal(result.status, 'passed');
  });

  // -----------------------------------------------------------------------
  // Reviewer error
  // -----------------------------------------------------------------------

  it('handles reviewer throwing error gracefully', async () => {
    const reviewFn = mock.fn<(req: FixReviewRequest) => Promise<ReviewVerdict>>();
    reviewFn.mock.mockImplementationOnce(async () => { throw new Error('network error'); }, 0);
    reviewFn.mock.mockImplementationOnce(async () => makePassVerdict(), 1);
    mocks.fixReviewer.review = reviewFn;
    loop = createFixItLoop({ ...mocks });

    const result = await loop.run(makeContext({ maxAttempts: 2 }));

    // First attempt: reviewer threw -> recorded as fail, no fix applied
    assert.equal(result.history[0].fixApplied, false);
    assert.equal(result.history[0].verdict.status, 'fail');
    // Second attempt: passes
    assert.equal(result.status, 'passed');
    assert.equal(result.attempts, 2);
  });

  // -----------------------------------------------------------------------
  // Commit after fix
  // -----------------------------------------------------------------------

  it('commits after successful fix execution', async () => {
    const reviewFn = mock.fn<(req: FixReviewRequest) => Promise<ReviewVerdict>>();
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict(), 0);
    reviewFn.mock.mockImplementationOnce(async () => makePassVerdict(), 1);
    mocks.fixReviewer.review = reviewFn;

    const commitFn = mock.fn(async () => 'sha-fix-1');
    mocks.fixCommitter.commit = commitFn;
    loop = createFixItLoop({ ...mocks });

    const result = await loop.run(makeContext());

    assert.equal(commitFn.mock.callCount(), 1);
    const commitCall = commitFn.mock.calls[0];
    assert.equal(commitCall.arguments[0], '/tmp/wt');
    assert.equal(commitCall.arguments[1], 'fix: attempt 1');
    assert.equal(result.commitSha, 'sha-fix-1');
  });

  // -----------------------------------------------------------------------
  // Prompt builder arguments
  // -----------------------------------------------------------------------

  it('passes correct attempt number to prompt builder', async () => {
    const reviewFn = mock.fn<(req: FixReviewRequest) => Promise<ReviewVerdict>>();
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict(), 0);
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict(), 1);
    reviewFn.mock.mockImplementationOnce(async () => makePassVerdict(), 2);
    mocks.fixReviewer.review = reviewFn;

    const buildFn = mock.fn(() => 'fix it');
    mocks.fixPromptBuilder.build = buildFn;
    loop = createFixItLoop({ ...mocks });

    await loop.run(makeContext({ maxAttempts: 3 }));

    assert.equal(buildFn.mock.callCount(), 2); // two failed reviews -> two fix prompts
    // First call: attempt 1
    assert.equal(buildFn.mock.calls[0].arguments[2], 1);
    assert.equal(buildFn.mock.calls[0].arguments[3], 3); // maxAttempts
    // Second call: attempt 2
    assert.equal(buildFn.mock.calls[1].arguments[2], 2);
    assert.equal(buildFn.mock.calls[1].arguments[3], 3);
  });

  // -----------------------------------------------------------------------
  // Final review after exhaustion
  // -----------------------------------------------------------------------

  it('skips final review when last attempt has no commit', async () => {
    // All reviews fail, fix execution also fails, so no commit is made
    mocks.fixReviewer.review = mock.fn(async () => makeFailVerdict());
    const execFn = mock.fn(async (): Promise<FixExecutionResult> => ({
      status: 'failed',
      output: '',
      duration: 50,
      error: 'timeout',
    }));
    mocks.fixExecutor.executeFix = execFn;
    loop = createFixItLoop({ ...mocks });

    const result = await loop.run(makeContext({ maxAttempts: 2 }));

    assert.equal(result.status, 'failed');
    // In-loop reviews = 2, no final review because no commit was made in last attempt
    // The reviewer should have been called only for the in-loop reviews
    const reviewCallCount = (mocks.fixReviewer.review as ReturnType<typeof mock.fn>).mock.callCount();
    assert.equal(reviewCallCount, 2, 'Should only call reviewer for in-loop reviews, not final review');
  });

  it('does final review after all attempts exhausted', async () => {
    const reviewFn = mock.fn<(req: FixReviewRequest) => Promise<ReviewVerdict>>();
    // All in-loop reviews fail
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict(), 0);
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict(), 1);
    // Final review after exhaustion also fails
    reviewFn.mock.mockImplementationOnce(async () => makeFailVerdict({ feedback: 'still broken' }), 2);
    mocks.fixReviewer.review = reviewFn;
    loop = createFixItLoop({ ...mocks });

    const result = await loop.run(makeContext({ maxAttempts: 2 }));

    // 2 in-loop reviews + 1 final review = 3 total
    assert.equal(reviewFn.mock.callCount(), 3);
    // Final review should use attempt = maxAttempts + 1
    const finalCall = reviewFn.mock.calls[2];
    assert.equal(finalCall.arguments[0].attempt, 3); // maxAttempts(2) + 1
    assert.equal(result.status, 'failed');
    assert.equal(result.finalVerdict.feedback, 'still broken');
  });
});
